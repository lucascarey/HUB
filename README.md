# HUB

Tu cabeza en un solo lugar. Proyectos, tareas, ideas, eventos, plata y hábitos flotan en un espacio negro, conectados como neuronas. Con el **+** de la esquina tirás cualquier cosa, y cada proyecto se abre como su propio espacio.

## Cómo se usa

- **Moverse:** arrastrá el fondo. Zoom con la rueda o pellizcando.
- **Agregar:** el **+** de abajo a la derecha. Escribí lo que sea ("le debo $8.000 a Juli", "entrevista el jueves") y adivina el tipo.
- **Editar:** tocá cualquier cosa para cambiar título, fecha, área y conexiones, marcarla hecha o borrarla.
- **Proyectos:** doble toque para entrar. Adentro está todo lo del proyecto alrededor del núcleo.
- **Mañana:** lo que vence mañana late. El botón de arriba te lleva a cada una.

## Correrlo en tu compu

```bash
npm install
npm run dev
```

Abrí http://localhost:3000. Sin configurar nada, todo se guarda en ese navegador.

## Sincronizar compu y celu (Supabase)

1. Creá un proyecto en [Supabase](https://supabase.com).
2. En el SQL editor, corré `supabase/migrations/0001_init.sql`.
3. En *Authentication → URL Configuration*, agregá la URL de la app (por ejemplo la de Vercel) como *Site URL* y en *Redirect URLs*.
4. Copiá `.env.example` a `.env.local` y completá la URL y la *publishable key* del proyecto.
5. En la app, **Cuenta → Mandarme el link** con tu mail. La primera vez sube lo que tenías en el navegador.

## Estructura

| Carpeta | Qué hay |
| --- | --- |
| `src/components/Network.tsx` | La red: pan, zoom, arrastre, espacios por proyecto |
| `src/components/AddPanel.tsx` | La captura rápida del **+** |
| `src/components/DetailPanel.tsx` | Edición de un elemento y sus conexiones |
| `src/lib/store.ts` | Guardado local y en Supabase |
| `src/lib/types.ts` | El modelo: `Item` (cualquier cosa) y `Link` (conexión entre dos) |
| `supabase/migrations` | Tablas y permisos de la base |

Stack: Next.js, React, Supabase. Pensado para deployar en Vercel e instalar en el celu como app (PWA).

## Bandeja de Gmail

El recuadro "Bandeja" muestra los mails importantes sin leer (`is:unread is:important in:inbox`) y se actualiza cada 5 minutos. Solo lectura.

Necesita en Vercel: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` (cliente OAuth web de Google Cloud con la Gmail API activada y `https://<tu-app>/api/gmail/callback` como URI de redirección), `HUB_STATE_SECRET` y `HUB_DB_SECRET` (cadenas aleatorias). El hash de `HUB_DB_SECRET` se registra una vez en Supabase (ver `supabase/migrations/0002_gmail.sql`).
