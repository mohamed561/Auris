# AURIS

Private audiobook player. React + JavaScript, deployed on Vercel. Files stay on your device and are never uploaded; only the resume point syncs.

## Deploy
1. Create a PRIVATE GitHub repo and push this folder.
2. On vercel.com import the repo (Vite is detected automatically).
3. In the Vercel project, Storage tab, add an Upstash Redis database from the Marketplace and connect it to the project.
4. Add an environment variable SYNC_KEY with a long random secret, then redeploy.
5. Open the site on each device, name the device, and enter the same key once.

Local dev with the API: `npm install` then `npx vercel dev`.

## Notes
- Desktop Chrome/Edge remember the file after the first pick. Phones (and Safari/Firefox) ask you to re-pick the same file each session; the app recognizes it by fingerprint and resumes from the synced point.
- Resume point = where you paused minus 10 seconds. Tap -10/+10 repeatedly for 20s, 30s and so on. Keys: Space, Left, Right.
- Audible's own DRM files (.aax, .aa, .aaxc) cannot be played by any browser.
