// Publica en Instagram el carrusel que toca, con la API oficial de Meta.
// Corre dentro de GitHub Actions.
//
// Modos (variable MODO):
//   probar   → valida el token y que Instagram pueda leer las imágenes del próximo post. NO publica.
//   publicar → publica el post pendiente más antiguo cuya fecha (hora de Argentina) ya llegó.
//
// Cola: cada carpeta posts/AAAA-MM-DD-nombre/ con 01.jpg, 02.jpg, ... y caption.txt.
// Al publicar se crea publicado.json dentro de la carpeta, así no se repite.

import { readdir, readFile, writeFile, access } from 'node:fs/promises';
import path from 'node:path';

// Sirve con los dos tipos de token de Meta:
//  - token de Instagram (inicio de sesión con Instagram)      → graph.instagram.com, vence a los 60 días
//  - token de usuario del sistema (inicio de sesión unificado) → graph.facebook.com, no vence
const API_IG = 'https://graph.instagram.com';
const API_FB = 'https://graph.facebook.com';
let API = API_IG;
const IG_ID = (process.env.IG_ID || '17841423521488647').trim(); // id de @hallazgo.lat
const TOKEN = (process.env.IG_TOKEN || '').trim();
const MODO = (process.env.MODO || 'probar').trim();
const REPO = process.env.GITHUB_REPOSITORY; // usuario/repositorio
const SHA = process.env.GITHUB_SHA;
const USUARIO_ESPERADO = process.env.IG_USUARIO || 'hallazgo.lat';
const ZONA = 'America/Argentina/Buenos_Aires';
const POSTS_DIR = path.join(process.cwd(), 'posts');

function fail(msg) {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

if (!TOKEN) fail('Falta el secreto IG_TOKEN (GitHub → Settings → Secrets and variables → Actions).');
if (!['probar', 'publicar'].includes(MODO)) fail(`MODO desconocido: "${MODO}" (usa "probar" o "publicar").`);
if (!REPO || !SHA) fail('Este script está pensado para correr en GitHub Actions (faltan GITHUB_REPOSITORY / GITHUB_SHA).');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hoy = () => new Intl.DateTimeFormat('en-CA', { timeZone: ZONA }).format(new Date()); // AAAA-MM-DD
const primeraLinea = (s) => s.split('\n')[0].trim();

async function api(method, endpoint, params = {}) {
  const query = new URLSearchParams({ ...params, access_token: TOKEN });
  const url = method === 'GET' ? `${API}/${endpoint}?${query}` : `${API}/${endpoint}`;
  const res = await fetch(url, method === 'GET' ? {} : { method, body: query });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    const e = data.error || {};
    throw new Error(`${method} ${endpoint}: ${e.message || `HTTP ${res.status}`} (code ${e.code ?? '-'}, subcode ${e.error_subcode ?? '-'})`);
  }
  return data;
}

async function existe(p) {
  try { await access(p); return true; } catch { return false; }
}

async function pendientes() {
  const dirs = (await readdir(POSTS_DIR, { withFileTypes: true }))
    .filter((d) => d.isDirectory() && /^\d{4}-\d{2}-\d{2}-/.test(d.name))
    .map((d) => d.name)
    .sort();
  const out = [];
  for (const d of dirs) if (!(await existe(path.join(POSTS_DIR, d, 'publicado.json')))) out.push(d);
  return out;
}

async function cargarPost(dir) {
  const full = path.join(POSTS_DIR, dir);
  const files = (await readdir(full)).filter((f) => /^\d{2}\.jpe?g$/i.test(f)).sort();
  if (files.length < 2 || files.length > 10) fail(`${dir}: un carrusel necesita entre 2 y 10 imágenes y hay ${files.length}.`);
  const caption = (await readFile(path.join(full, 'caption.txt'), 'utf8')).replace(/^﻿/, '').replace(/\r\n/g, '\n').trim();
  if (!caption) fail(`${dir}: caption.txt está vacío.`);
  if (caption.length > 2200) fail(`${dir}: el texto tiene ${caption.length} caracteres (máximo 2200).`);
  const hashtags = (caption.match(/#[\p{L}\p{N}_]+/gu) || []).length;
  if (hashtags > 30) fail(`${dir}: tiene ${hashtags} hashtags (máximo 30).`);
  const urls = files.map((f) => `https://raw.githubusercontent.com/${REPO}/${SHA}/posts/${encodeURIComponent(dir)}/${f}`);
  return { dir, full, files, caption, urls };
}

async function verificarUrls(post) {
  for (const u of post.urls) {
    const r = await fetch(u, { method: 'HEAD' });
    const tipo = r.headers.get('content-type') || '';
    if (!r.ok) fail(`No se puede descargar ${u} (HTTP ${r.status}). ¿El repositorio es público?`);
    if (!tipo.startsWith('image/jpeg')) fail(`${u} se sirve como "${tipo}"; Instagram necesita image/jpeg.`);
  }
  console.log(`  ✓ las ${post.urls.length} imágenes se pueden descargar`);
}

async function esperarContenedor(id, nombre) {
  for (let i = 0; i < 40; i++) {
    const { status_code: estado, status } = await api('GET', id, { fields: 'status_code,status' });
    if (estado === 'FINISHED') return;
    if (estado === 'ERROR' || estado === 'EXPIRED') fail(`Instagram rechazó ${nombre}: ${status || estado}`);
    await sleep(5000);
  }
  fail(`${nombre} no terminó de procesarse a tiempo.`);
}

async function crearItems(igId, post) {
  const ids = [];
  for (const [i, url] of post.urls.entries()) {
    const { id } = await api('POST', `${igId}/media`, { image_url: url, is_carousel_item: 'true' });
    await esperarContenedor(id, `la imagen ${post.files[i]}`);
    ids.push(id);
    console.log(`  ✓ ${post.files[i]} aceptada por Instagram`);
  }
  return ids;
}

async function yaPublicado(igId, post) {
  const { data = [] } = await api('GET', `${igId}/media`, { fields: 'id,caption,permalink,timestamp', limit: '10' });
  return data.find((m) => m.caption && primeraLinea(m.caption) === primeraLinea(post.caption));
}

async function marcar(post, id, permalink, timestamp) {
  const registro = { id, permalink, timestamp: timestamp || new Date().toISOString() };
  await writeFile(path.join(post.full, 'publicado.json'), `${JSON.stringify(registro, null, 2)}\n`);
}

// Los tokens de Instagram vencen a los 60 días; renovarlo seguido los mantiene vivos.
async function renovarToken() {
  if (API === API_FB) {
    console.log('Token: es de usuario del sistema, no vence.');
    return;
  }
  try {
    const r = await fetch(`${API}/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(TOKEN)}`);
    const d = await r.json().catch(() => ({}));
    if (!d.access_token) {
      console.log(`Token: no se renovó (${d.error?.message || `HTTP ${r.status}`}). Es normal si tiene menos de 24 h.`);
      return;
    }
    const dias = Math.round((d.expires_in || 0) / 86400);
    if (d.access_token === TOKEN) console.log(`Token renovado: vale ${dias} días más.`);
    else console.log(`::warning::Instagram entregó un token nuevo (vale ${dias} días). Hay que reemplazar el secreto IG_TOKEN antes de que venza el actual.`);
  } catch (e) {
    console.log(`Token: no se pudo renovar (${e.message}).`);
  }
}

// Prueba primero como token de Instagram y, si no, como token de usuario del sistema.
async function conectar() {
  let errorIg;
  try {
    const me = await api('GET', 'me', { fields: 'user_id,username,account_type' });
    console.log(`Cuenta conectada: @${me.username} (${me.account_type || 'tipo desconocido'}) · API de Instagram`);
    return { igId: me.user_id, username: me.username };
  } catch (e) {
    errorIg = e.message;
  }
  API = API_FB;
  try {
    const cuenta = await api('GET', IG_ID, { fields: 'id,username' });
    console.log(`Cuenta conectada: @${cuenta.username} · API de Facebook (usuario del sistema)`);
    return { igId: cuenta.id, username: cuenta.username };
  } catch (e) {
    fail(`El token no sirvió con ninguna de las dos APIs.\n  Instagram: ${errorIg}\n  Facebook: ${e.message}`);
  }
}

async function main() {
  console.log(`Modo: ${MODO} · Fecha en Argentina: ${hoy()}`);
  const { igId, username } = await conectar();
  if (username !== USUARIO_ESPERADO) fail(`El token es de @${username}, se esperaba @${USUARIO_ESPERADO}.`);
  const cola = await pendientes();

  if (MODO === 'probar') {
    if (!cola.length) {
      console.log('No hay posts pendientes en la cola.');
    } else {
      const post = await cargarPost(cola[0]);
      console.log(`Probando con el próximo post: ${post.dir} (${post.files.length} imágenes)`);
      await verificarUrls(post);
      await crearItems(igId, post);
      console.log('PRUEBA OK: el token funciona e Instagram puede leer las imágenes. No se publicó nada.');
      console.log(`Cola pendiente: ${cola.join(', ')}`);
    }
    await renovarToken();
    return;
  }

  const fecha = hoy();
  const toca = cola.filter((d) => d.slice(0, 10) <= fecha);
  if (!toca.length) {
    console.log(`Hoy no toca publicar. Próximo en la cola: ${cola[0] || '(cola vacía)'}`);
    await renovarToken();
    return;
  }

  const post = await cargarPost(toca[0]);
  console.log(`Publicando ${post.dir} (${post.files.length} imágenes)`);
  const previo = await yaPublicado(igId, post);
  if (previo) {
    console.log(`Ya estaba publicado (${previo.permalink}); solo lo marco como hecho.`);
    await marcar(post, previo.id, previo.permalink, previo.timestamp);
    return;
  }

  await verificarUrls(post);
  const hijos = await crearItems(igId, post);
  const { id: carrusel } = await api('POST', `${igId}/media`, {
    media_type: 'CAROUSEL',
    children: hijos.join(','),
    caption: post.caption,
  });
  await esperarContenedor(carrusel, 'el carrusel');
  const { id: mediaId } = await api('POST', `${igId}/media_publish`, { creation_id: carrusel });
  const { permalink, timestamp } = await api('GET', mediaId, { fields: 'permalink,timestamp' });
  console.log(`PUBLICADO: ${permalink}`);
  await marcar(post, mediaId, permalink, timestamp);
  await renovarToken();
}

main().catch((e) => fail(e.message));
