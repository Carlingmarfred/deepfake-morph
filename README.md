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

## How it works

1. Load or capture two face images.
2. The app detects face landmarks and crops both images to a shared square framing.
3. It samples a curated subset of facial control points plus border anchors.
4. It builds a cost matrix from normalized geometry, semantic region order, and local color descriptors.
5. It solves the balanced transport problem exactly with a from-scratch transportation simplex.
6. It converts the transport plan into structure-aware target control points.
7. It triangulates the intermediate face and warps both images into that shared mesh.
8. It blends the warped faces into the final morph and lets you download a PNG.

## Publish to GitHub

This folder is ready to become its own GitHub repository.

If you want this project to live as a standalone repo, the cleanest approach is:

1. Put the contents of this folder in their own directory or repository root.
2. Run these commands inside that folder:

```powershell
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPOSITORY.git
git push -u origin main
```

After the first push, you can enable GitHub Pages in the repository settings, or let the included workflow deploy the site automatically from the `main` branch.

## Notes

- The first page load downloads MediaPipe runtime assets and the face landmark model from public CDNs, so an internet connection is required.
- Camera access works on `localhost`, which is why the app includes a small local web server instead of opening `index.html` directly from disk.
- The transport layer is implemented locally in [`optimal-transport.js`](./optimal-transport.js).
