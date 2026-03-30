import vision from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/+esm";

const { FaceLandmarker, FilesetResolver } = vision;

const WASM_ROOT = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm";
const MODEL_PATH =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";

let imageLandmarkerPromise;
let videoLandmarkerPromise;

async function createLandmarker(runningMode) {
  const filesetResolver = await FilesetResolver.forVisionTasks(WASM_ROOT);
  const sharedOptions = {
    runningMode,
    numFaces: 1,
    outputFaceBlendshapes: false,
    outputFacialTransformationMatrixes: false,
  };

  try {
    return await FaceLandmarker.createFromOptions(filesetResolver, {
      baseOptions: {
        modelAssetPath: MODEL_PATH,
        delegate: "GPU",
      },
      ...sharedOptions,
    });
  } catch {
    return FaceLandmarker.createFromOptions(filesetResolver, {
      baseOptions: {
        modelAssetPath: MODEL_PATH,
      },
      ...sharedOptions,
    });
  }
}

export async function warmupFaceLandmarker() {
  if (!imageLandmarkerPromise) {
    imageLandmarkerPromise = createLandmarker("IMAGE").catch((error) => {
      imageLandmarkerPromise = null;
      throw error;
    });
  }

  return imageLandmarkerPromise;
}

export async function warmupVideoFaceLandmarker() {
  if (!videoLandmarkerPromise) {
    videoLandmarkerPromise = createLandmarker("VIDEO").catch((error) => {
      videoLandmarkerPromise = null;
      throw error;
    });
  }

  return videoLandmarkerPromise;
}

export async function detectFaceLandmarks(imageSource) {
  const landmarker = await warmupFaceLandmarker();
  const result = landmarker.detect(imageSource);
  const landmarks = result?.faceLandmarks?.[0];

  if (!landmarks) {
    throw new Error("No face detected. Try a clearer, front-facing photo.");
  }

  return landmarks;
}

export async function detectVideoFaceLandmarks(videoSource, timestampMs) {
  const landmarker = await warmupVideoFaceLandmarker();
  const result = landmarker.detectForVideo(videoSource, timestampMs);
  return result?.faceLandmarks?.[0] ?? null;
}
