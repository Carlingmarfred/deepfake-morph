import { solveOptimalTransport } from "./optimal-transport.js";

export const MORPH_SIZE = 512;

const STRUCTURE_BLEND = 0.66;
const COLOR_SAMPLE_RADIUS = 2;
const INSIDE_TOLERANCE = -1e-3;

const FEATURE_GROUPS = [
  {
    name: "oval",
    indices: [10, 338, 297, 284, 251, 389, 356, 454, 361, 397, 379, 400, 152, 176, 150, 172, 136, 58, 132, 93, 234, 127, 162, 54, 67, 109],
  },
  {
    name: "leftBrow",
    indices: [70, 63, 105, 66, 107, 55, 52, 46],
  },
  {
    name: "rightBrow",
    indices: [336, 296, 334, 293, 300, 285, 282, 276],
  },
  {
    name: "leftEye",
    indices: [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246],
  },
  {
    name: "rightEye",
    indices: [263, 249, 390, 373, 374, 380, 381, 382, 362, 398, 384, 385, 386, 387, 388, 466],
  },
  {
    name: "nose",
    indices: [168, 197, 5, 4, 45, 220, 115, 48, 64, 98, 2, 327, 294, 278, 344, 440, 275],
  },
  {
    name: "lips",
    indices: [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 308, 324, 318, 402, 14, 178, 88, 95, 185, 40, 39, 0, 267, 269, 270],
  },
];

const ANCHOR_TEMPLATE = [
  [0, 0],
  [0.25, 0],
  [0.5, 0],
  [0.75, 0],
  [1, 0],
  [1, 0.25],
  [1, 0.5],
  [1, 0.75],
  [1, 1],
  [0.75, 1],
  [0.5, 1],
  [0.25, 1],
  [0, 1],
  [0, 0.75],
  [0, 0.5],
  [0, 0.25],
];

const CONTROL_POINT_METADATA = [];
const seenLandmarks = new Set();

FEATURE_GROUPS.forEach((group) => {
  const groupSize = group.indices.length;

  group.indices.forEach((index, groupOrder) => {
    if (!seenLandmarks.has(index)) {
      seenLandmarks.add(index);
      CONTROL_POINT_METADATA.push({
        index,
        group: group.name,
        groupOrder,
        groupSize,
      });
    }
  });
});

export const CONTROL_POINT_COUNT = CONTROL_POINT_METADATA.length + ANCHOR_TEMPLATE.length;

export async function createFaceMorph({ sourceCanvas, targetCanvas, sourceLandmarks, targetLandmarks, alpha }) {
  await nextFrame();

  const width = sourceCanvas.width;
  const height = sourceCanvas.height;

  if (width !== targetCanvas.width || height !== targetCanvas.height) {
    throw new Error("Source and target canvases must share the same dimensions.");
  }

  const sourceContext = sourceCanvas.getContext("2d", { willReadFrequently: true });
  const targetContext = targetCanvas.getContext("2d", { willReadFrequently: true });
  const sourceImageData = sourceContext.getImageData(0, 0, width, height);
  const targetImageData = targetContext.getImageData(0, 0, width, height);

  const sourcePoints = buildFacePoints(sourceLandmarks, sourceImageData, width, height);
  const targetPoints = buildFacePoints(targetLandmarks, targetImageData, width, height);
  const costMatrix = buildCostMatrix(sourcePoints, targetPoints);
  const pointCount = sourcePoints.length;
  const masses = Array(pointCount).fill(1 / pointCount);
  const transport = solveOptimalTransport(costMatrix, masses, masses);
  const adaptedTargetPoints = computeAdaptedTargets(sourcePoints, targetPoints, transport.plan);
  const anchors = createAnchors(width, height);
  const allSourcePoints = sourcePoints.concat(anchors);
  const allTargetPoints = adaptedTargetPoints.concat(anchors);
  const midpointPoints = allSourcePoints.map((sourcePoint, index) =>
    lerpPoint(sourcePoint, allTargetPoints[index], alpha),
  );
  const triangles = delaunayTriangulate(midpointPoints);
  const morphedImage = warpAndBlend({
    sourceImageData,
    targetImageData,
    width,
    height,
    sourcePoints: allSourcePoints,
    targetPoints: allTargetPoints,
    midpointPoints,
    triangles,
    alpha,
  });

  const outputCanvas = document.createElement("canvas");
  outputCanvas.width = width;
  outputCanvas.height = height;
  outputCanvas.getContext("2d").putImageData(morphedImage, 0, 0);

  return {
    canvas: outputCanvas,
    controlPointCount: midpointPoints.length,
    transport: {
      iterations: transport.iterations,
      activePairs: transport.activePairs,
      totalCost: transport.totalCost,
      meanDrift: computeMeanDrift(targetPoints, adaptedTargetPoints),
    },
  };
}

function buildFacePoints(landmarks, imageData, width, height) {
  const landmarkPoints = CONTROL_POINT_METADATA.map((meta) => ({
    index: meta.index,
    group: meta.group,
    groupOrder: meta.groupOrder,
    groupSize: meta.groupSize,
    x: landmarks[meta.index].x * width,
    y: landmarks[meta.index].y * height,
  }));

  const frame = computeFrame(landmarkPoints);

  return landmarkPoints.map((point) => {
    const color = sampleMeanColor(imageData, width, height, point.x, point.y, COLOR_SAMPLE_RADIUS);
    const relX = (point.x - frame.centerX) / frame.scale;
    const relY = (point.y - frame.centerY) / frame.scale;

    return {
      ...point,
      relX,
      relY,
      radius: Math.hypot(relX, relY),
      angle: Math.atan2(relY, relX),
      color,
    };
  });
}

function buildCostMatrix(sourcePoints, targetPoints) {
  return sourcePoints.map((sourcePoint) =>
    targetPoints.map((targetPoint) => {
      const positionDistance = Math.hypot(sourcePoint.relX - targetPoint.relX, sourcePoint.relY - targetPoint.relY);
      const radiusDistance = Math.abs(sourcePoint.radius - targetPoint.radius);
      const angleDistance = Math.abs(wrapAngle(sourcePoint.angle - targetPoint.angle)) / Math.PI;
      const colorDistance =
        Math.hypot(
          sourcePoint.color[0] - targetPoint.color[0],
          sourcePoint.color[1] - targetPoint.color[1],
          sourcePoint.color[2] - targetPoint.color[2],
        ) / 441.6729559300637;
      const semanticDistance =
        sourcePoint.group === targetPoint.group
          ? Math.abs(sourcePoint.groupOrder - targetPoint.groupOrder) / Math.max(sourcePoint.groupSize - 1, 1)
          : 1;
      const groupPenalty = sourcePoint.group === targetPoint.group ? 0 : 1.35;

      return (
        0.58 * positionDistance +
        0.12 * radiusDistance +
        0.08 * angleDistance +
        0.12 * colorDistance +
        0.18 * semanticDistance +
        groupPenalty
      );
    }),
  );
}

function computeAdaptedTargets(sourcePoints, targetPoints, plan) {
  const adaptedTargets = [];

  for (let row = 0; row < sourcePoints.length; row += 1) {
    let totalMass = 0;
    let weightedX = 0;
    let weightedY = 0;

    for (let column = 0; column < targetPoints.length; column += 1) {
      const mass = plan[row][column];
      if (mass <= 0) {
        continue;
      }

      totalMass += mass;
      weightedX += mass * targetPoints[column].x;
      weightedY += mass * targetPoints[column].y;
    }

    const otPoint =
      totalMass > 0
        ? {
            x: weightedX / totalMass,
            y: weightedY / totalMass,
          }
        : {
            x: targetPoints[row].x,
            y: targetPoints[row].y,
          };

    adaptedTargets.push({
      ...targetPoints[row],
      x: lerp(otPoint.x, targetPoints[row].x, STRUCTURE_BLEND),
      y: lerp(otPoint.y, targetPoints[row].y, STRUCTURE_BLEND),
    });
  }

  return adaptedTargets;
}

function createAnchors(width, height) {
  const maxX = width - 1;
  const maxY = height - 1;

  return ANCHOR_TEMPLATE.map(([x, y], index) => ({
    x: x * maxX,
    y: y * maxY,
    index: `anchor-${index}`,
    group: "anchor",
  }));
}

function warpAndBlend({
  sourceImageData,
  targetImageData,
  width,
  height,
  sourcePoints,
  targetPoints,
  midpointPoints,
  triangles,
  alpha,
}) {
  const output = new ImageData(width, height);
  const outputData = output.data;
  const sourceData = sourceImageData.data;
  const targetData = targetImageData.data;
  const sourceSample = new Float32Array(4);
  const targetSample = new Float32Array(4);

  for (let offset = 0; offset < outputData.length; offset += 4) {
    outputData[offset] = clampChannel(sourceData[offset] * (1 - alpha) + targetData[offset] * alpha);
    outputData[offset + 1] = clampChannel(sourceData[offset + 1] * (1 - alpha) + targetData[offset + 1] * alpha);
    outputData[offset + 2] = clampChannel(sourceData[offset + 2] * (1 - alpha) + targetData[offset + 2] * alpha);
    outputData[offset + 3] = 255;
  }

  for (const triangle of triangles) {
    const midpointA = midpointPoints[triangle[0]];
    const midpointB = midpointPoints[triangle[1]];
    const midpointC = midpointPoints[triangle[2]];
    const sourceA = sourcePoints[triangle[0]];
    const sourceB = sourcePoints[triangle[1]];
    const sourceC = sourcePoints[triangle[2]];
    const targetA = targetPoints[triangle[0]];
    const targetB = targetPoints[triangle[1]];
    const targetC = targetPoints[triangle[2]];
    const denominator =
      (midpointB.y - midpointC.y) * (midpointA.x - midpointC.x) +
      (midpointC.x - midpointB.x) * (midpointA.y - midpointC.y);

    if (Math.abs(denominator) < 1e-8) {
      continue;
    }

    const minX = Math.max(0, Math.floor(Math.min(midpointA.x, midpointB.x, midpointC.x)));
    const maxX = Math.min(width - 1, Math.ceil(Math.max(midpointA.x, midpointB.x, midpointC.x)));
    const minY = Math.max(0, Math.floor(Math.min(midpointA.y, midpointB.y, midpointC.y)));
    const maxY = Math.min(height - 1, Math.ceil(Math.max(midpointA.y, midpointB.y, midpointC.y)));

    for (let y = minY; y <= maxY; y += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        const sampleX = x + 0.5;
        const sampleY = y + 0.5;
        const [weightA, weightB, weightC] = barycentricWeights(sampleX, sampleY, midpointA, midpointB, midpointC, denominator);

        if (weightA < INSIDE_TOLERANCE || weightB < INSIDE_TOLERANCE || weightC < INSIDE_TOLERANCE) {
          continue;
        }

        const sourceX = weightA * sourceA.x + weightB * sourceB.x + weightC * sourceC.x;
        const sourceY = weightA * sourceA.y + weightB * sourceB.y + weightC * sourceC.y;
        const targetX = weightA * targetA.x + weightB * targetB.x + weightC * targetC.x;
        const targetY = weightA * targetA.y + weightB * targetB.y + weightC * targetC.y;

        sampleBilinear(sourceData, width, height, sourceX, sourceY, sourceSample);
        sampleBilinear(targetData, width, height, targetX, targetY, targetSample);

        const offset = (y * width + x) * 4;
        outputData[offset] = clampChannel(sourceSample[0] * (1 - alpha) + targetSample[0] * alpha);
        outputData[offset + 1] = clampChannel(sourceSample[1] * (1 - alpha) + targetSample[1] * alpha);
        outputData[offset + 2] = clampChannel(sourceSample[2] * (1 - alpha) + targetSample[2] * alpha);
        outputData[offset + 3] = 255;
      }
    }
  }

  return output;
}

function delaunayTriangulate(points) {
  const pointSet = points.map((point) => ({ x: point.x, y: point.y }));
  const superTriangle = createSuperTriangle(pointSet);
  const augmentedPoints = pointSet.concat(superTriangle);
  const firstSuperIndex = pointSet.length;
  const secondSuperIndex = pointSet.length + 1;
  const thirdSuperIndex = pointSet.length + 2;
  let triangles = [makeTriangle(firstSuperIndex, secondSuperIndex, thirdSuperIndex, augmentedPoints)];

  for (let index = 0; index < pointSet.length; index += 1) {
    const point = augmentedPoints[index];
    const badTriangles = triangles.filter((triangle) => isPointInsideCircumcircle(point, triangle.circle));
    const boundaryEdges = collectBoundaryEdges(badTriangles);
    const badSet = new Set(badTriangles);

    triangles = triangles.filter((triangle) => !badSet.has(triangle));

    boundaryEdges.forEach(([left, right]) => {
      triangles.push(makeTriangle(left, right, index, augmentedPoints));
    });
  }

  return triangles
    .filter((triangle) => triangle.a < pointSet.length && triangle.b < pointSet.length && triangle.c < pointSet.length)
    .map((triangle) => [triangle.a, triangle.b, triangle.c]);
}

function collectBoundaryEdges(triangles) {
  const edgeCounts = new Map();

  triangles.forEach((triangle) => {
    [
      [triangle.a, triangle.b],
      [triangle.b, triangle.c],
      [triangle.c, triangle.a],
    ].forEach((edge) => {
      const edgeKey = normalizeEdgeKey(edge[0], edge[1]);
      const record = edgeCounts.get(edgeKey);

      if (record) {
        record.count += 1;
      } else {
        edgeCounts.set(edgeKey, { count: 1, edge });
      }
    });
  });

  return Array.from(edgeCounts.values())
    .filter((record) => record.count === 1)
    .map((record) => record.edge);
}

function makeTriangle(a, b, c, points) {
  if (cross(points[a], points[b], points[c]) < 0) {
    [b, c] = [c, b];
  }

  return {
    a,
    b,
    c,
    circle: circumcircle(points[a], points[b], points[c]),
  };
}

function circumcircle(a, b, c) {
  const ax = a.x;
  const ay = a.y;
  const bx = b.x;
  const by = b.y;
  const cx = c.x;
  const cy = c.y;
  const denominator = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));

  if (Math.abs(denominator) < 1e-8) {
    const centerX = (ax + bx + cx) / 3;
    const centerY = (ay + by + cy) / 3;
    return {
      x: centerX,
      y: centerY,
      radiusSquared: Number.POSITIVE_INFINITY,
    };
  }

  const ax2ay2 = ax * ax + ay * ay;
  const bx2by2 = bx * bx + by * by;
  const cx2cy2 = cx * cx + cy * cy;
  const x = (ax2ay2 * (by - cy) + bx2by2 * (cy - ay) + cx2cy2 * (ay - by)) / denominator;
  const y = (ax2ay2 * (cx - bx) + bx2by2 * (ax - cx) + cx2cy2 * (bx - ax)) / denominator;
  const radiusSquared = (x - ax) ** 2 + (y - ay) ** 2;

  return { x, y, radiusSquared };
}

function createSuperTriangle(points) {
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const span = Math.max(maxX - minX, maxY - minY);
  const midX = (minX + maxX) / 2;
  const midY = (minY + maxY) / 2;

  return [
    { x: midX - 20 * span, y: midY - span },
    { x: midX, y: midY + 20 * span },
    { x: midX + 20 * span, y: midY - span },
  ];
}

function isPointInsideCircumcircle(point, circle) {
  const deltaX = point.x - circle.x;
  const deltaY = point.y - circle.y;
  return deltaX * deltaX + deltaY * deltaY <= circle.radiusSquared + 1e-4;
}

function barycentricWeights(x, y, a, b, c, denominator) {
  const weightA = ((b.y - c.y) * (x - c.x) + (c.x - b.x) * (y - c.y)) / denominator;
  const weightB = ((c.y - a.y) * (x - c.x) + (a.x - c.x) * (y - c.y)) / denominator;
  const weightC = 1 - weightA - weightB;
  return [weightA, weightB, weightC];
}

function sampleBilinear(data, width, height, x, y, output) {
  const clampedX = clamp(x, 0, width - 1.001);
  const clampedY = clamp(y, 0, height - 1.001);
  const x0 = Math.floor(clampedX);
  const y0 = Math.floor(clampedY);
  const x1 = Math.min(width - 1, x0 + 1);
  const y1 = Math.min(height - 1, y0 + 1);
  const tx = clampedX - x0;
  const ty = clampedY - y0;
  const offset00 = (y0 * width + x0) * 4;
  const offset10 = (y0 * width + x1) * 4;
  const offset01 = (y1 * width + x0) * 4;
  const offset11 = (y1 * width + x1) * 4;

  for (let channel = 0; channel < 4; channel += 1) {
    const top = data[offset00 + channel] * (1 - tx) + data[offset10 + channel] * tx;
    const bottom = data[offset01 + channel] * (1 - tx) + data[offset11 + channel] * tx;
    output[channel] = top * (1 - ty) + bottom * ty;
  }
}

function sampleMeanColor(imageData, width, height, x, y, radius) {
  const data = imageData.data;
  let red = 0;
  let green = 0;
  let blue = 0;
  let count = 0;

  for (let sampleY = Math.max(0, Math.floor(y - radius)); sampleY <= Math.min(height - 1, Math.ceil(y + radius)); sampleY += 1) {
    for (let sampleX = Math.max(0, Math.floor(x - radius)); sampleX <= Math.min(width - 1, Math.ceil(x + radius)); sampleX += 1) {
      const offset = (sampleY * width + sampleX) * 4;
      red += data[offset];
      green += data[offset + 1];
      blue += data[offset + 2];
      count += 1;
    }
  }

  return [red / count, green / count, blue / count];
}

function computeFrame(points) {
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);

  return {
    centerX: (minX + maxX) / 2,
    centerY: (minY + maxY) / 2,
    scale: Math.max(maxX - minX, maxY - minY, 1),
  };
}

function computeMeanDrift(directTargets, adaptedTargets) {
  let total = 0;

  for (let index = 0; index < directTargets.length; index += 1) {
    total += Math.hypot(adaptedTargets[index].x - directTargets[index].x, adaptedTargets[index].y - directTargets[index].y);
  }

  return total / directTargets.length;
}

function cross(a, b, c) {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function normalizeEdgeKey(a, b) {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

function wrapAngle(value) {
  let wrapped = value;

  while (wrapped > Math.PI) {
    wrapped -= Math.PI * 2;
  }

  while (wrapped < -Math.PI) {
    wrapped += Math.PI * 2;
  }

  return wrapped;
}

function lerp(start, end, amount) {
  return start + (end - start) * amount;
}

function lerpPoint(left, right, amount) {
  return {
    x: lerp(left.x, right.x, amount),
    y: lerp(left.y, right.y, amount),
  };
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function clampChannel(value) {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}
