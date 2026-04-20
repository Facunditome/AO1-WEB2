const http = require('http');
const fs = require('fs/promises');
const { URL } = require('url');
const path = require('path');
const mime = require('mime').default;

const PORT = 3000;
const RUTA_NOTICIAS = path.join(__dirname, 'public', 'noticias.txt');
const RUTA_PUBLIC = path.join(__dirname, 'public');
const cache = {};

function serializarNoticia(titulo, cuerpo) {
    return JSON.stringify({ titulo, cuerpo });
}

function parsearNoticia(linea) {
    try {
        const noticia = JSON.parse(linea);
        if (typeof noticia.titulo === 'string' && typeof noticia.cuerpo === 'string') {
            return {
                titulo: noticia.titulo.trim(),
                cuerpo: noticia.cuerpo.trim()
            };
        }
    } catch {
        // Compatibilidad con líneas antiguas: solo texto.
    }

    return {
        titulo: linea.trim(),
        cuerpo: ''
    };
}

function responder500(respuesta, mensaje = '500: Error interno del servidor') {
    respuesta.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    respuesta.end(mensaje);
}

function escaparHTML(texto) {
    return texto
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

async function leerNoticias() {
    try {
        const contenido = await fs.readFile(RUTA_NOTICIAS, 'utf-8');
        return contenido
            .split('\n')
            .map((n) => n.trim())
            .filter(Boolean)
            .map(parsearNoticia);
    } catch (error) {
        if (error.code === 'ENOENT') {
            return [];
        }
        throw error;
    }
}

async function manejarInicio(respuesta) {
    const noticias = await leerNoticias();
    const items = noticias
        .map((noticia, indice) => `<li>${escaparHTML(noticia.titulo)} <a href="/noticia?id=${indice}">Ver detalle</a></li>`)
        .join('');

    const html = `<!doctype html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Portal de Noticias</title>
  <link rel="stylesheet" href="/estilos.css">
</head>
<body>
  <div class="container">
    <h1>Portal de Noticias</h1>
    ${noticias.length ? `<ul>${items}</ul>` : '<p>No hay noticias aún.</p>'}
    <a href="/formulario.html">Publicar nueva noticia</a>
  </div>
</body>
</html>`;

    respuesta.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    respuesta.end(html);
}

async function manejarDetalle(url, respuesta) {
    const id = Number(url.searchParams.get('id'));
    if (!Number.isInteger(id) || id < 0) {
        respuesta.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        respuesta.end('404: Noticia no encontrada');
        return;
    }

    const noticias = await leerNoticias();
    const noticia = noticias[id];
    if (!noticia) {
        respuesta.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        respuesta.end('404: Noticia no encontrada');
        return;
    }

    const cuerpoHTML = noticia.cuerpo
        ? `<p>${escaparHTML(noticia.cuerpo)}</p>`
        : '<p><em>Esta noticia no tiene cuerpo cargado.</em></p>';

    const html = `<!doctype html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <title>Detalle de noticia</title>
  <link rel="stylesheet" href="/estilos.css">
</head>
<body>
  <div class="container">
    <h1>Detalle de noticia</h1>
    <h2>${escaparHTML(noticia.titulo)}</h2>
    ${cuerpoHTML}
    <a href="/">Volver al listado</a>
  </div>
</body>
</html>`;

    respuesta.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    respuesta.end(html);
}

function manejarPublicacion(pedido, respuesta) {
    let cuerpo = '';

    pedido.on('data', (chunk) => {
        cuerpo += chunk;
    });

    pedido.on('end', async () => {
        try {
            const datos = new URLSearchParams(cuerpo);
            const titulo = (datos.get('titulo') || '').trim();
            const cuerpoNoticia = (datos.get('cuerpo') || '').trim();

            if (!titulo || !cuerpoNoticia) {
                respuesta.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
                respuesta.end('400: Debe enviar titulo y cuerpo');
                return;
            }

            const registro = serializarNoticia(titulo, cuerpoNoticia);
            await fs.appendFile(RUTA_NOTICIAS, `${registro}\n`, 'utf-8');
            respuesta.writeHead(302, { Location: '/' });
            respuesta.end();
        } catch {
            responder500(respuesta, '500: No se pudo guardar la noticia');
        }
    });

    pedido.on('error', () => {
        responder500(respuesta, '500: Error al recibir datos del formulario');
    });
}

async function servirEstatico(pathname, respuesta) {
    const nombre = pathname === '/' ? '/index.html' : pathname;
    // noticias.txt vive en public/ pero no se sirve como estático (solo lo usa el servidor).
    if (nombre === '/noticias.txt') {
        respuesta.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        respuesta.end('404: Recurso no encontrado');
        return;
    }
    const rutaAbsoluta = path.join(RUTA_PUBLIC, nombre);

    if (!rutaAbsoluta.startsWith(RUTA_PUBLIC)) {
        respuesta.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        respuesta.end('404: Recurso no encontrado');
        return;
    }

    try {
        const stats = await fs.stat(rutaAbsoluta);
        if (!stats.isFile()) {
            respuesta.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            respuesta.end('404: Recurso no encontrado');
            return;
        }

        const entradaCache = cache[rutaAbsoluta];
        if (entradaCache && entradaCache.mtimeMs === stats.mtimeMs) {
            console.log(`Cache HIT -> ${nombre}`);
            respuesta.writeHead(200, { 'Content-Type': entradaCache.contentType });
            respuesta.end(entradaCache.contenido);
            return;
        }

        const contenido = await fs.readFile(rutaAbsoluta);
        const contentType = mime.getType(rutaAbsoluta) || 'application/octet-stream';
        cache[rutaAbsoluta] = {
            contenido,
            mtimeMs: stats.mtimeMs,
            contentType
        };
        console.log(`Cache MISS -> ${nombre}`);
        respuesta.writeHead(200, { 'Content-Type': contentType });
        respuesta.end(contenido);
    } catch (error) {
        if (error.code === 'ENOENT') {
            respuesta.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            respuesta.end('404: Recurso no encontrado');
            return;
        }
        responder500(respuesta);
    }
}

const servidor = http.createServer(async (pedido, respuesta) => {
    try {
        const url = new URL(pedido.url, `http://localhost:${PORT}`);
        const pathname = decodeURIComponent(url.pathname);

        if (pedido.method === 'GET' && pathname === '/') {
            await manejarInicio(respuesta);
            return;
        }

        if (pedido.method === 'GET' && pathname === '/noticia') {
            await manejarDetalle(url, respuesta);
            return;
        }

        if (pedido.method === 'POST' && pathname === '/publicar') {
            manejarPublicacion(pedido, respuesta);
            return;
        }

        if (pedido.method === 'GET') {
            await servirEstatico(pathname, respuesta);
            return;
        }

        respuesta.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        respuesta.end('404: Ruta no encontrada');
    } catch {
        responder500(respuesta);
    }
});

servidor.listen(PORT, () => {
    console.log(`Servidor activo en http://localhost:${PORT}`);
});