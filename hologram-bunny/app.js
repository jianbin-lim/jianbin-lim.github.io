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
  const codeEl = $("#code");
  const gutterEl = $("#gutter");
  const codeRightEl = $("#code-right");
  const gutterRightEl = $("#gutter-right");
  const telemetryEl = $("#telemetry");
  const scanLabelEl = $("#scan-label");
  const zoomLabelEl = $("#zoom-label");
  const pointLabelEl = $("#point-label");
  const meshCountEl = $("#mesh-count");
  const cursorStatusEl = $("#cursor-status");
  const resetButton = $("#reset");
  const scanBeamEl = $("#scanbeam");
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const TAU = Math.PI * 2;
  const CAMERA_Z = 2.85;
  const CODE_START = 13; // 0-based; line 14 of kernel/groups.c
  const source = window.GROUPS_SOURCE || [];
  const cloudSource = window.RABBIT_POINTS;

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
  let codeLayoutTimer = 0;
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

    for (let i = 0; i < count; i += 1) {
      const offset = i * 9;
      x[i] = dv.getInt16(offset, true) / 32767;
      y[i] = dv.getInt16(offset + 2, true) / 32767;
      z[i] = dv.getInt16(offset + 4, true) / 32767;
      nx[i] = dv.getInt8(offset + 6) / 127;
      ny[i] = dv.getInt8(offset + 7) / 127;
      nz[i] = dv.getInt8(offset + 8) / 127;
      const hash = Math.sin(i * 127.1 + 311.7) * 43758.5453;
      seed[i] = hash - Math.floor(hash);
    }

    return { count, x, y, z, nx, ny, nz, seed };
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

        float alpha = (vis + rim + beam * 0.35) * band * flicker * 1.08;
        if (p.y > 0.20) alpha *= 1.18;
        if (p.y < -0.34) alpha *= 1.06;
        if (p.y > 0.44) alpha *= 0.42;

        float size = (1.16 + 1.8 * front + 0.9 * beam + 1.25 * rim + (aSeed > 0.976 ? 0.7 : 0.0)) * (0.82 + 0.32 * aSeed);
        if (p.y > 0.20) size *= 1.06;
        if (p.y > 0.44) size *= 0.7;

        float glowPass = uPass;
        gl_PointSize = clamp(size * mix(3.0, 12.0, glowPass) * uDpr, 2.0, 60.0);
        vAlpha = clamp(alpha * mix(0.92, 0.11, glowPass), 0.0, 0.95);
        vHot = min(max(beam * 0.6, 0.0), 1.0);
      }
    `;

    const fragmentSource = `
      precision mediump float;
      uniform mediump float uPass;
      varying float vAlpha;
      varying float vHot;

      void main() {
        vec2 uv = gl_PointCoord - vec2(0.5);
        float d = length(uv) * 2.0;
        if (d > 1.0) discard;

        vec3 cyan = vec3(0.05, 1.0, 0.93);
        vec3 hot = vec3(0.85, 1.0, 1.0);

        if (uPass > 0.5) {
          float halo = pow(max(0.0, 1.0 - d), 2.2);
          float a = vAlpha * halo;
          gl_FragColor = vec4(cyan * a, a);
          return;
        }

        float core = smoothstep(0.22, 0.0, d);
        float halo = pow(max(0.0, 1.0 - d), 2.0);
        vec3 color = mix(cyan, hot, min(max(vHot, 0.0), 1.0) * core);
        float alpha = vAlpha * (core * 0.9 + halo * 0.22);
        gl_FragColor = vec4(color * alpha, alpha);
      }
    `;

    const program = createProgram(vertexSource, fragmentSource);
    if (!program) return false;

    const count = pointCloud.count;
    const interleaved = new Float32Array(count * 7);
    for (let i = 0; i < count; i += 1) {
      const offset = i * 7;
      interleaved[offset] = pointCloud.x[i];
      interleaved[offset + 1] = pointCloud.y[i];
      interleaved[offset + 2] = pointCloud.z[i];
      interleaved[offset + 3] = pointCloud.nx[i];
      interleaved[offset + 4] = pointCloud.ny[i];
      interleaved[offset + 5] = pointCloud.nz[i];
      interleaved[offset + 6] = pointCloud.seed[i];
    }

    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, interleaved, gl.STATIC_DRAW);

    const stride = 7 * 4;
    const attributes = {
      position: gl.getAttribLocation(program, "aPosition"),
      normal: gl.getAttribLocation(program, "aNormal"),
      seed: gl.getAttribLocation(program, "aSeed"),
    };

    glState = {
      program,
      buffer,
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
      scheduleCodeBuild();
      return;
    }

    glowCanvas.width = Math.max(1, Math.round(width / 3));
    glowCanvas.height = Math.max(1, Math.round(height / 3));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    glowCtx.imageSmoothingEnabled = true;
    glowCtx.imageSmoothingQuality = "high";
    scheduleCodeBuild();
  }

  function scheduleCodeBuild() {
    window.clearTimeout(codeLayoutTimer);
    codeLayoutTimer = window.setTimeout(buildCode, 80);
  }

  /* ------------------------------------------------------------------------
     Code backdrop
     ------------------------------------------------------------------------ */

  const KEYWORDS =
    "struct|int|void|if|else|for|while|return|goto|static|const|unsigned|" +
    "char|long|short|sizeof|typedef|enum|union|extern|inline|volatile|register";

  const TOKEN_RE = new RegExp(
    "(\\/\\*.*?\\*\\/|\\/\\/.*$)" +
      '|("(?:\\\\.|[^"\\\\])*")' +
      `|\\b(${KEYWORDS})\\b` +
      "|\\b([A-Z][A-Z0-9_]{2,})\\b" +
      "|\\b(\\d+)\\b" +
      "|([A-Za-z_]\\w*)(?=\\s*\\()",
    "g"
  );

  function escapeHtml(value) {
    return value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function highlightLine(line) {
    if (!line) return "&nbsp;";
    const trimmed = line.trimStart();
    if (
      trimmed.startsWith("/*") ||
      trimmed.startsWith("*") ||
      trimmed.startsWith("//")
    ) {
      return `<span class="tok-comment">${escapeHtml(line)}</span>`;
    }
    if (trimmed.startsWith("#")) {
      return `<span class="tok-pre">${escapeHtml(line)}</span>`;
    }

    let html = "";
    let last = 0;
    let match;
    TOKEN_RE.lastIndex = 0;
    while ((match = TOKEN_RE.exec(line)) !== null) {
      html += escapeHtml(line.slice(last, match.index));
      if (match[1] || match[2]) {
        html += `<span class="tok-comment">${escapeHtml(match[1] || match[2])}</span>`;
      } else if (match[3]) {
        html += `<span class="tok-key">${escapeHtml(match[3])}</span>`;
      } else if (match[4]) {
        html += `<span class="tok-type">${escapeHtml(match[4])}</span>`;
      } else if (match[5]) {
        html += `<span class="tok-num">${escapeHtml(match[5])}</span>`;
      } else if (match[6]) {
        html += `<span class="tok-fn">${escapeHtml(match[6])}</span>`;
      } else {
        html += escapeHtml(match[0]);
      }
      last = TOKEN_RE.lastIndex;
    }
    html += escapeHtml(line.slice(last));
    return html || "&nbsp;";
  }

  function buildCodePanel(targetCode, targetGutter, startLine, activeIndex, caretOnActive) {
    if (!targetCode || !targetGutter) return;
    const codeStyle = window.getComputedStyle(targetCode);
    const lineHeight = parseFloat(codeStyle.lineHeight) || 23;
    const wrap = targetCode.parentElement;
    const available = Math.max(0, wrap.clientHeight - 13);
    const visibleLines = Math.max(10, Math.floor(available / lineHeight) + 1);

    let codeHtml = "";
    let gutterHtml = "";

    for (let i = 0; i < visibleLines; i += 1) {
      const index = startLine + i;
      const line = source[index] || "";
      const isActive = index === activeIndex;
      const caret = isActive && caretOnActive ? '<span class="caret"></span>' : "";
      codeHtml += `<span class="code-line${isActive ? " active" : ""}">${highlightLine(
        line
      )}${caret}</span>`;
      gutterHtml += `<span class="gutter-line${isActive ? " active" : ""}">${
        index + 1
      }</span>`;
    }

    targetCode.innerHTML = codeHtml;
    targetGutter.innerHTML = gutterHtml;
  }

  function buildCode() {
    if (!codeEl || !gutterEl || !source.length) return;

    const activeIndex = source.findIndex((line) => line.includes("nblocks = nblocks"));
    const rightActiveIndex = source.findIndex((line) =>
      line.includes("void groups_free")
    );

    buildCodePanel(codeEl, gutterEl, CODE_START, activeIndex, true);
    buildCodePanel(
      codeRightEl,
      gutterRightEl,
      CODE_START + 42,
      rightActiveIndex,
      false
    );

    if (activeIndex >= 0 && cursorStatusEl) {
      cursorStatusEl.textContent = `Ln ${activeIndex + 1}, Col 1`;
    }
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

    // One fill style + per-point alpha keeps this fast in Canvas 2D. The soft
    // halo comes from the low-resolution bloom pass below, not from a sprite.
    ctx.fillStyle = "rgba(58,255,242,1)";

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
      if (py > 0.20) alpha *= 1.14;
      if (py < -0.34) alpha *= 1.06;
      if (py > 0.44) alpha *= 0.62;
      if (alpha < 0.018) continue;
      if (alpha > 0.97) alpha = 0.97;

      let size =
        (1.16 +
          1.8 * front +
          0.9 * beam +
          1.25 * rim +
          (seed[i] > 0.976 ? 0.7 : 0)) *
        (0.82 + 0.32 * seed[i]);
      if (py > 0.20) size *= 1.06;
      if (py > 0.44) size *= 0.7;

      if (seed[i] > 0.994) {
        alpha = Math.min(0.98, alpha * 1.35);
        size *= 1.25;
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
    activeCount = Math.min(
      cloud.count,
      window.innerWidth < 720 || window.innerHeight < 620 ? 8000 : 12000
    );

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
    buildCode();
    window.addEventListener("resize", resize);
    if ("ResizeObserver" in window) {
      new ResizeObserver(resize).observe(body);
    }
    if (document.fonts?.ready) {
      document.fonts.ready.then(() => {
        buildCode();
      });
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
