(() => {
  "use strict";

  const $ = (selector, root = document) => root.querySelector(selector);
  const canvas = $("#scene");
  if (!canvas) return;

  let gl = null;
  try {
    gl =
      canvas.getContext("webgl", {
        alpha: true,
        antialias: false,
        depth: false,
        premultipliedAlpha: true,
        powerPreference: "high-performance",
      }) ||
      canvas.getContext("experimental-webgl", {
        alpha: true,
        antialias: false,
        depth: false,
        premultipliedAlpha: true,
      });
  } catch (error) {
    gl = null;
  }
  const ctx = gl ? null : canvas.getContext("2d", { alpha: true });
  if (!gl && !ctx) return;

  const body = $("#holo-body");
  const holo = $("#holo");
  const telemetryEl = $("#telemetry");
  const scanLabelEl = $("#scan-label");
  const zoomLabelEl = $("#zoom-label");
  const pointLabelEl = $("#point-label");
  const meshCountEl = $("#mesh-count");
  const resetButton = $("#reset");
  const scanBeamEl = $("#scanbeam");
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const TAU = Math.PI * 2;
  const CAMERA_Z = 2.85;
  const cloudSource = window.CARROT_POINTS;

  // Small palette used only by the Canvas 2D fallback. WebGL uses full RGB.
  const FALLBACK_PALETTE = [
    [255, 128, 24],
    [229, 94, 12],
    [112, 211, 56],
    [68, 155, 40],
    [255, 247, 231],
    [25, 88, 185],
    [54, 27, 15],
  ];
  const FALLBACK_STYLES = FALLBACK_PALETTE.map(
    ([r, g, b]) => `rgb(${r},${g},${b})`
  );

  if (!cloudSource || !cloudSource.data) {
    if (hudError("POINT DATA MISSING")) return;
  }

  const state = {
    yaw: -0.30,
    pitch: -0.018,
    zoom: 1,
    userYaw: -0.30,
    userPitch: -0.018,
    targetZoom: 1,
    pointerX: 0,
    pointerY: 0,
    dragging: false,
    drag: null,
    lastDrag: -1e9,
    auto: !reduceMotion,
    reduced: reduceMotion,
    lastTime: 0,
    hudTime: 0,
    scanProgress: 0,
  };

  const view = {
    width: 1,
    height: 1,
    dpr: 1,
    cx: 0,
    cy: 0,
    scale: 300,
  };

  const glowCanvas = document.createElement("canvas");
  const glowCtx = glowCanvas.getContext("2d", { alpha: true });

  let cloud = null;
  let activeCount = 0;
  let sprite = null;
  let dust = [];
  let rafId = 0;
  let glitchTimer = 0;
  let glState = null;

  function hudError(message) {
    if (telemetryEl) telemetryEl.textContent = message;
    return true;
  }

  function decodeCloud(data) {
    const binary = window.atob(data.data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }

    const count = data.count;
    const buffer = bytes.buffer;
    const dv = new DataView(buffer);
    const x = new Float32Array(count);
    const y = new Float32Array(count);
    const z = new Float32Array(count);
    const nx = new Float32Array(count);
    const ny = new Float32Array(count);
    const nz = new Float32Array(count);
    const seed = new Float32Array(count);
    const r = new Uint8Array(count);
    const g = new Uint8Array(count);
    const b = new Uint8Array(count);
    const palette = new Uint8Array(count);

    for (let i = 0; i < count; i += 1) {
      const offset = i * 12;
      x[i] = dv.getInt16(offset, true) / 32767;
      y[i] = dv.getInt16(offset + 2, true) / 32767;
      z[i] = dv.getInt16(offset + 4, true) / 32767;
      nx[i] = dv.getInt8(offset + 6) / 127;
      ny[i] = dv.getInt8(offset + 7) / 127;
      nz[i] = dv.getInt8(offset + 8) / 127;
      r[i] = dv.getUint8(offset + 9);
      g[i] = dv.getUint8(offset + 10);
      b[i] = dv.getUint8(offset + 11);

      let bestIndex = 0;
      let bestDistance = Infinity;
      for (let p = 0; p < FALLBACK_PALETTE.length; p += 1) {
        const entry = FALLBACK_PALETTE[p];
        const dr = r[i] - entry[0];
        const dg = g[i] - entry[1];
        const db = b[i] - entry[2];
        const distance = dr * dr + dg * dg + db * db;
        if (distance < bestDistance) {
          bestDistance = distance;
          bestIndex = p;
        }
      }
      palette[i] = bestIndex;

      const hash = Math.sin(i * 127.1 + 311.7) * 43758.5453;
      seed[i] = hash - Math.floor(hash);
    }

    return { count, x, y, z, nx, ny, nz, seed, r, g, b, palette };
  }

  function createGlowSprite() {
    const size = 64;
    const offscreen = document.createElement("canvas");
    offscreen.width = size;
    offscreen.height = size;
    const g = offscreen.getContext("2d");
    const center = size / 2;
    const gradient = g.createRadialGradient(center, center, 0, center, center, center);
    gradient.addColorStop(0, "rgba(255,255,255,1)");
    gradient.addColorStop(0.1, "rgba(232,255,253,1)");
    gradient.addColorStop(0.2, "rgba(120,255,247,0.98)");
    gradient.addColorStop(0.38, "rgba(35,255,236,0.55)");
    gradient.addColorStop(0.6, "rgba(0,255,229,0.16)");
    gradient.addColorStop(0.82, "rgba(0,255,229,0.035)");
    gradient.addColorStop(1, "rgba(0,255,229,0)");
    g.fillStyle = gradient;
    g.fillRect(0, 0, size, size);
    return offscreen;
  }

  function makeDust() {
    const rng = mulberry32(0x51a7);
    const particles = [];
    for (let i = 0; i < 86; i += 1) {
      particles.push({
        x: rng(),
        y: rng(),
        speed: 0.003 + rng() * 0.014,
        phase: rng() * TAU,
        size: 0.35 + rng() * 0.9,
      });
    }
    return particles;
  }

  function mulberry32(seed) {
    let value = seed >>> 0;
    return () => {
      value += 0x6d2b79f5;
      let t = value;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function compileShader(type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      console.error("Shader compile failed:", gl.getShaderInfoLog(shader));
      gl.deleteShader(shader);
      return null;
    }
    return shader;
  }

  function createProgram(vertexSource, fragmentSource) {
    const vertexShader = compileShader(gl.VERTEX_SHADER, vertexSource);
    const fragmentShader = compileShader(gl.FRAGMENT_SHADER, fragmentSource);
    if (!vertexShader || !fragmentShader) return null;

    const program = gl.createProgram();
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);
    gl.deleteShader(vertexShader);
    gl.deleteShader(fragmentShader);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.error("Program link failed:", gl.getProgramInfoLog(program));
      gl.deleteProgram(program);
      return null;
    }
    return program;
  }

  function setupWebGL(pointCloud) {
    const vertexSource = `
      precision highp float;
      attribute vec3 aPosition;
      attribute vec3 aNormal;
      attribute vec3 aColor;
      attribute float aSeed;

      uniform float uYaw;
      uniform float uPitch;
      uniform float uScale;
      uniform float uTime;
      uniform float uScanY;
      uniform float uWidth;
      uniform float uHeight;
      uniform float uDpr;
      uniform mediump float uPass;

      varying float vAlpha;
      varying float vHot;
      varying vec3 vColor;

      void main() {
        float cy = cos(uYaw);
        float sy = sin(uYaw);
        float cp = cos(uPitch);
        float sp = sin(uPitch);

        vec3 p = aPosition;
        float rx = p.x * cy + p.z * sy;
        float rz = -p.x * sy + p.z * cy;
        float ry = p.y * cp - rz * sp;
        float depth = p.y * sp + rz * cp;
        float persp = 2.85 / max(0.85, 2.85 - depth);

        float px = uWidth * 0.5 + rx * persp * uScale;
        float py = uHeight * 0.505 - ry * persp * uScale;
        gl_Position = vec4(px / uWidth * 2.0 - 1.0, 1.0 - py / uHeight * 2.0, 0.0, 1.0);

        float nx = aNormal.x * cy + aNormal.z * sy;
        float nz = -aNormal.x * sy + aNormal.z * cy;
        float ny = aNormal.y * cp - nz * sp;
        float face = ny * sp + nz * cp;

        float front = max(0.0, face);
        float rim = face > 0.0 ? pow(1.0 - front, 3.0) * 0.72 : 0.0;
        float light = max(0.0, -0.34 * nx + 0.42 * ny + 0.84 * face);
        float vis = face > 0.0 ? 0.32 + 0.68 * front : 0.03 + 0.07 * (1.0 + face);
        vis *= 0.82 + 0.18 * light;

        float dy = py - uScanY;
        float beam = exp(-(dy * dy) / 620.0);

        float row = 0.5 + 0.5 * sin(py * 1.08 + sin(uTime * 0.55) * 0.45 + aSeed * 0.5);
        float band = 0.11 + 0.89 * pow(row, 4.0);
        float flicker = 0.86 + 0.14 * sin(uTime * 2.45 + aSeed * 31.0);

        float alpha = (vis + rim + beam * 0.35) * band * flicker * 1.1;
        if (p.y > 0.10) alpha *= 1.08;

        float size = (1.16 + 1.8 * front + 0.9 * beam + 1.25 * rim + (aSeed > 0.976 ? 0.7 : 0.0)) * (0.82 + 0.32 * aSeed);
        if (p.y > 0.10) size *= 1.03;

        // The orange body reads a little fuller than the green leaves/eyes.
        float warm = step(aColor.g + 0.08, aColor.r);
        alpha *= mix(1.0, 1.1, warm);
        size *= mix(1.0, 1.25, warm);

        float glowPass = uPass;
        gl_PointSize = clamp(size * mix(3.0, 12.0, glowPass) * uDpr, 2.0, 60.0);
        vAlpha = clamp(alpha * mix(0.92, 0.11, glowPass), 0.0, 0.95);
        vHot = min(max(beam * 0.6, 0.0), 1.0);
        vColor = aColor;
      }
    `;

    const fragmentSource = `
      precision mediump float;
      uniform mediump float uPass;
      varying float vAlpha;
      varying float vHot;
      varying vec3 vColor;

      void main() {
        vec2 uv = gl_PointCoord - vec2(0.5);
        float d = length(uv) * 2.0;
        if (d > 1.0) discard;

        if (uPass > 0.5) {
          float halo = pow(max(0.0, 1.0 - d), 2.2);
          float a = vAlpha * halo;
          gl_FragColor = vec4(vColor * a, a);
          return;
        }

        float core = smoothstep(0.22, 0.0, d);
        float halo = pow(max(0.0, 1.0 - d), 2.0);
        vec3 color = mix(vColor, vec3(1.0), min(max(vHot, 0.0), 1.0) * core * 0.45);
        float alpha = vAlpha * (core * 0.9 + halo * 0.22);
        gl_FragColor = vec4(color * alpha, alpha);
      }
    `;

    const program = createProgram(vertexSource, fragmentSource);
    if (!program) return false;

    const count = pointCloud.count;
    const interleaved = new Float32Array(count * 7);
    const colors = new Float32Array(count * 3);
    for (let i = 0; i < count; i += 1) {
      const offset = i * 7;
      interleaved[offset] = pointCloud.x[i];
      interleaved[offset + 1] = pointCloud.y[i];
      interleaved[offset + 2] = pointCloud.z[i];
      interleaved[offset + 3] = pointCloud.nx[i];
      interleaved[offset + 4] = pointCloud.ny[i];
      interleaved[offset + 5] = pointCloud.nz[i];
      interleaved[offset + 6] = pointCloud.seed[i];

      colors[i * 3] = pointCloud.r[i] / 255;
      colors[i * 3 + 1] = pointCloud.g[i] / 255;
      colors[i * 3 + 2] = pointCloud.b[i] / 255;
    }

    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, interleaved, gl.STATIC_DRAW);

    const colorBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, colorBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, colors, gl.STATIC_DRAW);

    const stride = 7 * 4;
    const attributes = {
      position: gl.getAttribLocation(program, "aPosition"),
      normal: gl.getAttribLocation(program, "aNormal"),
      color: gl.getAttribLocation(program, "aColor"),
      seed: gl.getAttribLocation(program, "aSeed"),
    };

    glState = {
      program,
      buffer,
      colorBuffer,
      attributes,
      uniforms: {
        yaw: gl.getUniformLocation(program, "uYaw"),
        pitch: gl.getUniformLocation(program, "uPitch"),
        scale: gl.getUniformLocation(program, "uScale"),
        time: gl.getUniformLocation(program, "uTime"),
        scanY: gl.getUniformLocation(program, "uScanY"),
        width: gl.getUniformLocation(program, "uWidth"),
        height: gl.getUniformLocation(program, "uHeight"),
        dpr: gl.getUniformLocation(program, "uDpr"),
        pass: gl.getUniformLocation(program, "uPass"),
      },
    };

    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.enableVertexAttribArray(attributes.position);
    gl.vertexAttribPointer(attributes.position, 3, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(attributes.normal);
    gl.vertexAttribPointer(attributes.normal, 3, gl.FLOAT, false, stride, 12);
    gl.enableVertexAttribArray(attributes.seed);
    gl.vertexAttribPointer(attributes.seed, 1, gl.FLOAT, false, stride, 24);

    gl.bindBuffer(gl.ARRAY_BUFFER, colorBuffer);
    gl.enableVertexAttribArray(attributes.color);
    gl.vertexAttribPointer(attributes.color, 3, gl.FLOAT, false, 3 * 4, 0);

    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.clearColor(0, 0, 0, 0);
    return true;
  }

  function updateBeam(scanY) {
    if (scanBeamEl) {
      scanBeamEl.style.transform = `translate3d(0, ${scanY - 40}px, 0)`;
    }
  }

  function resize() {
    const rect = body.getBoundingClientRect();
    const width = Math.max(1, rect.width);
    const height = Math.max(1, rect.height);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    if (
      Math.abs(width - view.width) < 0.5 &&
      Math.abs(height - view.height) < 0.5 &&
      dpr === view.dpr
    ) {
      return;
    }

    view.width = width;
    view.height = height;
    view.dpr = dpr;
    view.cx = width / 2;
    view.cy = height * 0.505;
    view.scale = height * (window.innerWidth < 720 ? 0.68 : 0.75);

    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;

    if (gl) {
      gl.viewport(0, 0, canvas.width, canvas.height);
      return;
    }

    glowCanvas.width = Math.max(1, Math.round(width / 3));
    glowCanvas.height = Math.max(1, Math.round(height / 3));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    glowCtx.imageSmoothingEnabled = true;
    glowCtx.imageSmoothingQuality = "high";
  }

  /* ------------------------------------------------------------------------
     Rendering
     ------------------------------------------------------------------------ */

  function updateState(now, dt) {
    const t = now / 1000;
    const sinceDrag = now - state.lastDrag;
    const swaying =
      state.auto &&
      !state.dragging &&
      !state.reduced &&
      sinceDrag > 2400;

    const sway = swaying
      ? Math.sin(t * 0.21) * 0.24 + Math.sin(t * 0.083 + 1.3) * 0.055
      : 0;
    const targetYaw = state.userYaw + sway + state.pointerX * 0.06;
    const targetPitch =
      state.userPitch +
      state.pointerY * 0.032 +
      (swaying ? Math.sin(t * 0.17) * 0.028 : 0);

    const yawEase = 1 - Math.exp(-dt * 5.2);
    const pitchEase = 1 - Math.exp(-dt * 5.2);
    state.yaw += (targetYaw - state.yaw) * yawEase;
    state.pitch += (targetPitch - state.pitch) * pitchEase;
    state.zoom += (state.targetZoom - state.zoom) * (1 - Math.exp(-dt * 7));
    state.scanProgress = (t * 0.065) % 1;
  }

  function drawDust(t) {
    const w = view.width;
    const h = view.height;
    for (let i = 0; i < dust.length; i += 1) {
      const particle = dust[i];
      const y = ((particle.y - t * particle.speed) % 1 + 1) % 1;
      const x =
        particle.x +
        Math.sin(t * 0.22 + particle.phase) * 0.012;
      const flicker = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(t * 1.7 + particle.phase));
      const size = particle.size * 2.2;
      ctx.globalAlpha = 0.035 + flicker * 0.055;
      ctx.drawImage(sprite, x * w - size, y * h - size, size * 2, size * 2);
    }
  }

  function drawWebGL(now, dt) {
    updateState(now, dt);

    const w = view.width;
    const h = view.height;
    const t = state.reduced ? 0 : now / 1000;
    const scanY = state.reduced
      ? h * 0.5
      : h * 0.08 + state.scanProgress * h * 0.84;

    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(glState.program);

    gl.uniform1f(glState.uniforms.yaw, state.yaw);
    gl.uniform1f(glState.uniforms.pitch, state.pitch);
    gl.uniform1f(glState.uniforms.scale, view.scale * state.zoom);
    gl.uniform1f(glState.uniforms.time, t);
    gl.uniform1f(glState.uniforms.scanY, scanY);
    gl.uniform1f(glState.uniforms.width, w);
    gl.uniform1f(glState.uniforms.height, h);
    gl.uniform1f(glState.uniforms.dpr, view.dpr);

    gl.drawArrays(gl.POINTS, 0, activeCount);
    gl.uniform1f(glState.uniforms.pass, 1.0);
    gl.drawArrays(gl.POINTS, 0, activeCount);
    gl.uniform1f(glState.uniforms.pass, 0.0);
    updateBeam(scanY);
  }

  function drawScene(now, dt) {
    if (gl && glState) {
      drawWebGL(now, dt);
      return;
    }

    updateState(now, dt);

    const w = view.width;
    const h = view.height;
    const t = state.reduced ? 0 : now / 1000;
    const yaw = state.yaw;
    const pitch = state.pitch;
    const cosY = Math.cos(yaw);
    const sinY = Math.sin(yaw);
    const cosP = Math.cos(pitch);
    const sinP = Math.sin(pitch);
    const scale = view.scale * state.zoom;
    const cx = view.cx;
    const cy = view.cy;
    const scanY = state.reduced
      ? h * 0.5
      : h * 0.08 + state.scanProgress * h * 0.84;

    ctx.clearRect(0, 0, w, h);
    ctx.globalCompositeOperation = "lighter";

    drawDust(t);

    const count = activeCount;
    const x = cloud.x;
    const y = cloud.y;
    const z = cloud.z;
    const nx = cloud.nx;
    const ny = cloud.ny;
    const nz = cloud.nz;
    const seed = cloud.seed;

    // One fill style at a time; the Canvas 2D fallback uses a small palette.
    let lastStyle = "";
    const palette = cloud.palette;

    for (let i = 0; i < count; i += 1) {
      const px = x[i];
      const py = y[i];
      const pz = z[i];

      const rx = px * cosY + pz * sinY;
      const rz = -px * sinY + pz * cosY;
      const ry = py * cosP - rz * sinP;
      const depth = py * sinP + rz * cosP;
      const perspective = CAMERA_Z / Math.max(0.85, CAMERA_Z - depth);

      const sx = cx + rx * perspective * scale;
      const sy = cy - ry * perspective * scale;
      if (sx < -18 || sx > w + 18 || sy < -18 || sy > h + 18) continue;

      const tnx = nx[i] * cosY + nz[i] * sinY;
      const tnz = -nx[i] * sinY + nz[i] * cosY;
      const tny = ny[i] * cosP - tnz * sinP;
      const face = tny * sinP + tnz * cosP;

      const front = face > 0 ? face : 0;
      let visibility =
        face > 0
          ? 0.32 + 0.68 * front
          : 0.03 + 0.07 * (1 + face);
      const rim = face > 0 ? (1 - front) * (1 - front) * (1 - front) * 0.72 : 0;
      const light = Math.max(0, -0.34 * tnx + 0.42 * tny + 0.84 * face);
      visibility *= 0.82 + 0.18 * light;

      const dy = sy - scanY;
      const beam = Math.exp(-(dy * dy) / 620);

      const row =
        0.5 +
        0.5 *
          Math.sin(
            sy * 1.08 + Math.sin(t * 0.55) * 0.45 + seed[i] * 0.5
          );
      const band = 0.18 + 0.82 * row * row * row * row;
      const flicker = state.reduced
        ? 1
        : 0.86 + 0.14 * Math.sin(t * 2.45 + seed[i] * 31.0);

      let alpha = (visibility + rim + beam * 0.35) * band * flicker * 1.08;
      if (py > 0.10) alpha *= 1.08;
      if (alpha < 0.018) continue;
      if (alpha > 0.97) alpha = 0.97;

      let size =
        (1.16 +
          1.8 * front +
          0.9 * beam +
          1.25 * rim +
          (seed[i] > 0.976 ? 0.7 : 0)) *
        (0.82 + 0.32 * seed[i]);
      if (py > 0.10) size *= 1.03;

      if (seed[i] > 0.994) {
        alpha = Math.min(0.98, alpha * 1.35);
        size *= 1.25;
      }

      const style = FALLBACK_STYLES[palette[i]];
      if (style !== lastStyle) {
        ctx.fillStyle = style;
        lastStyle = style;
      }
      const core = Math.max(0.8, size * 0.72);
      ctx.globalAlpha = alpha;
      ctx.fillRect(sx - core * 0.5, sy - core * 0.5, core, core);
    }

    // Cheap bloom: downsample the point layer, blur it once, add it back.
    // This keeps the glow without a per-particle post-processing pass.
    if (typeof ctx.filter === "string") {
      glowCtx.clearRect(0, 0, glowCanvas.width, glowCanvas.height);
      glowCtx.drawImage(
        canvas,
        0,
        0,
        glowCanvas.width,
        glowCanvas.height
      );
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      ctx.globalAlpha = 0.52;
      ctx.filter = "blur(5px)";
      ctx.drawImage(glowCanvas, 0, 0, w, h);
      ctx.restore();
      ctx.filter = "none";
    }

    updateBeam(scanY);

    // A very quiet hot spot at the center of the projection.
    const halo = ctx.createRadialGradient(
      w * 0.5,
      h * 0.5,
      0,
      w * 0.5,
      h * 0.5,
      Math.min(w, h) * 0.4
    );
    halo.addColorStop(0, "rgba(0,255,230,0.028)");
    halo.addColorStop(0.5, "rgba(0,255,230,0.009)");
    halo.addColorStop(1, "rgba(0,255,230,0)");
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
    ctx.fillStyle = halo;
    ctx.fillRect(0, 0, w, h);
  }

  function updateHud(now) {
    const yawDegrees = (state.yaw * 180) / Math.PI;
    const pitchDegrees = (state.pitch * 180) / Math.PI;
    const yawSign = yawDegrees < 0 ? "−" : "+";
    const pitchSign = pitchDegrees < 0 ? "−" : "+";
    telemetryEl.textContent = `YAW ${yawSign}${Math.abs(yawDegrees).toFixed(
      1
    )}° / PITCH ${pitchSign}${Math.abs(pitchDegrees).toFixed(1)}°`;
    zoomLabelEl.textContent = state.zoom.toFixed(2);
    scanLabelEl.textContent = `SCAN ${String(
      Math.floor(state.scanProgress * 999)
    ).padStart(3, "0")}.${String(
      Math.floor((state.scanProgress * 999) % 1 * 10)
    )}`;
  }

  function frame(now) {
    const rawDt = state.lastTime ? (now - state.lastTime) / 1000 : 0.016;
    const dt = Math.min(0.05, Math.max(0.001, rawDt));
    state.lastTime = now;

    drawScene(now, dt);

    state.hudTime += dt;
    if (state.hudTime > 0.11) {
      updateHud(now);
      state.hudTime = 0;
    }

    rafId = requestAnimationFrame(frame);
  }

  /* ------------------------------------------------------------------------
     Input
     ------------------------------------------------------------------------ */

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function resetView() {
    state.userYaw = -0.30;
    state.userPitch = -0.018;
    state.targetZoom = 1;
    state.auto = !state.reduced;
    holo.classList.remove("is-paused");
  }

  canvas.addEventListener("pointerdown", (event) => {
    if (event.button !== undefined && event.button !== 0) return;
    state.dragging = true;
    state.drag = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      yaw: state.userYaw,
      pitch: state.userPitch,
    };
    state.lastDrag = performance.now();
    canvas.setPointerCapture?.(event.pointerId);
  });

  canvas.addEventListener("pointermove", (event) => {
    const rect = canvas.getBoundingClientRect();
    state.pointerX = clamp(((event.clientX - rect.left) / rect.width) * 2 - 1, -1, 1);
    state.pointerY = clamp(((event.clientY - rect.top) / rect.height) * 2 - 1, -1, 1);

    if (!state.dragging || !state.drag || event.pointerId !== state.drag.id) return;
    state.userYaw = state.drag.yaw + (event.clientX - state.drag.x) * 0.009;
    state.userPitch = clamp(
      state.drag.pitch + (event.clientY - state.drag.y) * 0.0065,
      -0.55,
      0.55
    );
    state.lastDrag = performance.now();
  });

  function endDrag(event) {
    if (!state.dragging) return;
    state.dragging = false;
    state.drag = null;
    state.lastDrag = performance.now();
    if (event && canvas.hasPointerCapture?.(event.pointerId)) {
      canvas.releasePointerCapture(event.pointerId);
    }
  }

  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);
  canvas.addEventListener("pointerleave", () => {
    if (!state.dragging) {
      state.pointerX = 0;
      state.pointerY = 0;
    }
  });

  canvas.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      const factor = Math.exp(-event.deltaY * 0.00115);
      state.targetZoom = clamp(state.targetZoom * factor, 0.72, 1.72);
    },
    { passive: false }
  );

  canvas.addEventListener("dblclick", (event) => {
    event.preventDefault();
    resetView();
  });

  resetButton.addEventListener("click", () => {
    resetView();
  });

  window.addEventListener("keydown", (event) => {
    if (event.code === "Space" && event.target !== resetButton) {
      event.preventDefault();
      state.auto = !state.auto;
      holo.classList.toggle("is-paused", !state.auto);
    } else if (event.key === "r" || event.key === "R") {
      resetView();
    }
  });

  document.addEventListener("visibilitychange", () => {
    state.lastTime = 0;
  });

  /* ------------------------------------------------------------------------
     Boot
     ------------------------------------------------------------------------ */

  function scheduleGlitch() {
    if (state.reduced) return;
    window.clearTimeout(glitchTimer);
    glitchTimer = window.setTimeout(
      () => {
        holo.classList.add("is-glitching");
        window.setTimeout(() => holo.classList.remove("is-glitching"), 190);
        scheduleGlitch();
      },
      6500 + Math.random() * 7000
    );
  }

  function boot() {
    cloud = decodeCloud(cloudSource);
    activeCount = cloud.count;

    if (gl) {
      if (!setupWebGL(cloud)) {
        hudError("WEBGL INIT FAILED");
        return;
      }
    } else {
      sprite = createGlowSprite();
      dust = makeDust();
    }

    pointLabelEl.textContent = `${(activeCount / 1000).toFixed(1)}K PTS`;
    meshCountEl.textContent = cloud.count.toLocaleString("en-US");

    resize();
    window.addEventListener("resize", resize);
    if ("ResizeObserver" in window) {
      new ResizeObserver(resize).observe(body);
    }

    window.setTimeout(() => holo.classList.add("is-ready"), 90);
    rafId = requestAnimationFrame(frame);
    scheduleGlitch();
  }

  boot();

  window.addEventListener("pagehide", () => {
    cancelAnimationFrame(rafId);
    window.clearTimeout(glitchTimer);
  });
})();
