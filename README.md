# Hallazgo — publicación automática en Instagram

Este repositorio publica solo los carruseles de [@hallazgo.lat](https://www.instagram.com/hallazgo.lat/), un post por día.

## Cómo funciona

- Todos los días a las **22:17 (hora de Argentina)**, GitHub Actions ejecuta `scripts/publicar.mjs`.
- Mira la carpeta `posts/` y publica el post **pendiente más antiguo cuya fecha ya llegó**.
- Cuando lo publica, guarda `publicado.json` en la carpeta del post (con el enlace), así no se repite.
- Si algo falla, GitHub manda un email avisando.

## Agregar un post a la cola

Crear una carpeta `posts/AAAA-MM-DD-nombre-corto/` con:

- `01.jpg`, `02.jpg`, … (entre 2 y 10 imágenes JPEG, 1080×1350)
- `caption.txt` con el texto completo (máximo 2200 caracteres)

La fecha del nombre es el día en que se publica.

## Probar sin publicar

Actions → **Publicar en Instagram** → *Run workflow* → modo **probar**.
Verifica el token y que Instagram pueda leer las imágenes del próximo post, sin publicar nada.

## El token

- Está guardado como secreto `IG_TOKEN` (Settings → Secrets and variables → Actions). Nunca va en el código.
- Sirve un token de usuario del sistema (app de Meta "Hallazgo Publicador", inicio de sesión unificado),
  que no vence, o un token de Instagram, que vence a los 60 días y el script renueva en cada ejecución.
  Si el registro muestra un aviso de "token nuevo", hay que generar uno y reemplazar el secreto.
