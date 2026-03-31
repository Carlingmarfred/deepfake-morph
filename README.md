# Deepfake OT Morph Lab

This is a no-build browser app that morphs one face into another with:

- webcam capture or image upload
- automatic face-centered cropping
- MediaPipe face landmarks for geometry extraction
- an exact optimal transport solver implemented from scratch with the transportation simplex
- piecewise affine warping and blending rendered on a canvas
- optional live face tracking from your webcam

## Project Files

- `index.html`, `styles.css`, `app.js`: UI and browser workflow
- `face-landmarks.js`: MediaPipe still-image and video landmark detection
- `optimal-transport.js`: from-scratch transportation simplex solver
- `morph.js`: transport-driven morphing, triangulation, and warping
- `server.ps1`, `launch-app.bat`, `start-localhost.bat`: local run helpers for Windows
- `.github/workflows/deploy-pages.yml`: automatic GitHub Pages deploy on push to `main`

## Run it

On Windows, from this folder:

```powershell
.\start-localhost.bat
```

Then open [http://localhost:8080/](http://localhost:8080/).

If you want the app window and server to launch together, use:

```powershell
.\launch-app.bat
```

You can also run the server directly:

```powershell
powershell -ExecutionPolicy Bypass -NoProfile -File .\server.ps1 -Port 8080
```

## Notes

- The first page load downloads MediaPipe runtime assets and the face landmark model from public CDNs, so an internet connection is required.
- Camera access works on `localhost`, which is why the app includes a small local web server instead of opening `index.html` directly from disk.
- The transport layer is implemented locally in [`optimal-transport.js`](./optimal-transport.js).
