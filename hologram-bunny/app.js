(() => {
  "use strict";

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

  const body = $("#holo-body");
  const holo = $("#holo");
  const inner = $("#mascot-inner");
  const scanBeam = $("#scanbeam");
  const telemetry = $("#telemetry");
  const scanLabel = $("#scan-label");
  const scaleLabel = $("#zoom-label");
  const resetButton = $("#reset");

  const playButton = $("#play");
  const progress = $("#progress");
  const progressFill = $("#progress-fill");
  const timeLabel = $("#time");
  const nowLyric = $("#now-lyric");
  const playerStatus = $("#player-status");
  const audioFileInput = $("#audio-file");
  const audio = $("#audio");

  const lyricLines = $$(".lyric-line");
  const LINE_DURATION = 4.8;
  const DEMO_DURATION = LINE_DURATION * lyricLines.length;
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const state = {
    tiltX: 0,
    tiltY: 0,
    targetTiltX: 0,
    targetTiltY: 0,
    scale: 1,
    targetScale: 1,
    pointerX: 0,
    pointerY: 0,
    dragging: false,
    drag: null,
    lastDrag: -1e9,
    scanProgress: 0,
    currentLine: -1,
    playing: false,
    demoElapsed: 0,
    mode: "demo",
    audioUrl: null,
  };

  let demoBase = 0;
  let demoStartedAt = 0;
  let lastFrame = 0;
  let hudTime = 0;
  let rafId = 0;
  let glitchTimer = 0;

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function formatTime(seconds) {
    const safe = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
    const minutes = Math.floor(safe / 60);
    const rest = Math.floor(safe % 60);
    return `${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
  }

  function getDuration() {
    if (state.mode === "audio" && Number.isFinite(audio.duration) && audio.duration > 0) {
      return audio.duration;
    }
    return DEMO_DURATION;
  }

  function getElapsed() {
    return state.mode === "audio" ? audio.currentTime : state.demoElapsed;
  }

  function setLine(index) {
    if (!lyricLines.length) return;
    const next = ((index % lyricLines.length) + lyricLines.length) % lyricLines.length;
    if (next === state.currentLine) return;
    state.currentLine = next;
    lyricLines.forEach((line, i) => {
      line.classList.toggle("is-active", i === next);
    });
    const text = lyricLines[next].lastElementChild?.textContent || "";
    nowLyric.textContent = text;
  }

  function updateLyric(elapsed) {
    const lyricClock = Number.isFinite(elapsed) ? Math.max(0, elapsed) : 0;
    const index = Math.floor((lyricClock % DEMO_DURATION) / LINE_DURATION);
    setLine(index);
  }

  function updateProgress() {
    const duration = getDuration();
    const elapsed = clamp(getElapsed(), 0, duration);
    const percent = duration > 0 ? (elapsed / duration) * 100 : 0;
    progressFill.style.width = `${percent}%`;
    timeLabel.textContent = `${formatTime(elapsed)} / ${formatTime(duration)}`;
    progress.setAttribute("aria-valuemin", "0");
    progress.setAttribute("aria-valuemax", String(Math.round(duration)));
    progress.setAttribute("aria-valuenow", String(Math.round(elapsed)));
  }

  function setPlaying(playing) {
    state.playing = playing;
    playButton.classList.toggle("is-playing", playing);
    playButton.textContent = playing ? "❚❚" : "▶";
    playButton.setAttribute("aria-label", playing ? "暂停" : "播放");
  }

  function playDemo() {
    demoBase = state.demoElapsed % DEMO_DURATION;
    demoStartedAt = performance.now();
    setPlaying(true);
  }

  function pauseDemo() {
    const now = performance.now();
    state.demoElapsed = (demoBase + (now - demoStartedAt) / 1000) % DEMO_DURATION;
    setPlaying(false);
  }

  function togglePlay() {
    if (state.mode === "audio" && audio.src) {
      if (audio.paused) {
        audio
          .play()
          .then(() => {
            setPlaying(true);
          })
          .catch(() => {
            playerStatus.textContent = "音频被拦截";
          });
      } else {
        audio.pause();
      }
      return;
    }

    if (state.playing) {
      pauseDemo();
    } else {
      playDemo();
    }
  }

  function seekTo(ratio) {
    const duration = getDuration();
    const next = clamp(ratio, 0, 1) * duration;

    if (state.mode === "audio" && audio.src) {
      if (Number.isFinite(audio.duration)) {
        audio.currentTime = next;
      }
    } else {
      state.demoElapsed = next;
      if (state.playing) {
        demoBase = next % DEMO_DURATION;
        demoStartedAt = performance.now();
      }
    }

    updateLyric(next);
    updateProgress();
  }

  function progressRatio(event) {
    const rect = progress.getBoundingClientRect();
    return clamp((event.clientX - rect.left) / rect.width, 0, 1);
  }

  progress.addEventListener("click", (event) => {
    seekTo(progressRatio(event));
  });

  progress.addEventListener("keydown", (event) => {
    const duration = getDuration();
    if (event.key === "ArrowRight") {
      event.preventDefault();
      seekTo(clamp((getElapsed() + 5) / duration, 0, 1));
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      seekTo(clamp((getElapsed() - 5) / duration, 0, 1));
    }
  });

  playButton.addEventListener("click", togglePlay);

  audioFileInput.addEventListener("change", () => {
    const file = audioFileInput.files?.[0];
    if (!file) return;

    if (state.audioUrl) URL.revokeObjectURL(state.audioUrl);
    state.audioUrl = URL.createObjectURL(file);
    state.mode = "audio";
    audio.src = state.audioUrl;
    playerStatus.textContent = "本地音频";

    audio.load();
    playerStatus.textContent = "本地音频 · 按播放";
  });

  audio.addEventListener("loadedmetadata", () => {
    state.mode = "audio";
    playerStatus.textContent = "本地音频";
    updateProgress();
    updateLyric(audio.currentTime);
  });

  audio.addEventListener("timeupdate", () => {
    if (state.mode !== "audio") return;
    updateLyric(audio.currentTime);
    updateProgress();
  });

  audio.addEventListener("play", () => setPlaying(true));
  audio.addEventListener("pause", () => setPlaying(false));
  audio.addEventListener("ended", () => {
    setPlaying(false);
    updateProgress();
  });
  audio.addEventListener("error", () => {
    if (state.mode === "audio" && audio.src) {
      playerStatus.textContent = "音频错误";
      setPlaying(false);
    }
  });

  function updateTilt(now) {
    const t = now / 1000;
    const recentDrag = now - state.lastDrag < 1600;
    const swaying = !reduceMotion && !state.dragging && !recentDrag;
    const swayX = swaying ? Math.sin(t * 0.34 + 1.1) * 2.1 : 0;
    const swayY = swaying ? Math.sin(t * 0.27) * 2.8 : 0;

    const targetX = state.targetTiltX + swayX + state.pointerY * 3.8;
    const targetY = state.targetTiltY + swayY + state.pointerX * 5.2;
    const ease = 0.085;

    state.tiltX += (targetX - state.tiltX) * ease;
    state.tiltY += (targetY - state.tiltY) * ease;
    state.scale += (state.targetScale - state.scale) * 0.1;

    inner.style.setProperty("--rx", `${state.tiltX.toFixed(3)}deg`);
    inner.style.setProperty("--ry", `${state.tiltY.toFixed(3)}deg`);
    inner.style.setProperty("--scale", state.scale.toFixed(3));
  }

  function updateScan(now) {
    const t = now / 1000;
    state.scanProgress = (t * 0.065) % 1;
    const height = body.clientHeight;
    const scanY = height * 0.08 + state.scanProgress * height * 0.84;
    if (scanBeam) {
      scanBeam.style.transform = `translate3d(0, ${scanY - 40}px, 0)`;
    }
  }

  function updateHud() {
    const xSign = state.tiltX < 0 ? "−" : "+";
    const ySign = state.tiltY < 0 ? "−" : "+";
    telemetry.textContent = `TILT X ${xSign}${Math.abs(state.tiltX).toFixed(
      1
    )}° / Y ${ySign}${Math.abs(state.tiltY).toFixed(1)}°`;
    scaleLabel.textContent = state.scale.toFixed(2);
    scanLabel.textContent = `SCAN ${String(
      Math.floor(state.scanProgress * 999)
    ).padStart(3, "0")}.${String(
      Math.floor((state.scanProgress * 999) % 1 * 10)
    )}`;
  }

  function frame(now) {
    if (!lastFrame) lastFrame = now;
    const dt = Math.min(0.05, (now - lastFrame) / 1000);
    lastFrame = now;

    if (state.playing && state.mode !== "audio") {
      state.demoElapsed = (demoBase + (now - demoStartedAt) / 1000) % DEMO_DURATION;
      updateLyric(state.demoElapsed);
      updateProgress();
    }

    updateTilt(now);
    updateScan(now);

    hudTime += dt;
    if (hudTime > 0.11) {
      updateHud();
      hudTime = 0;
    }

    rafId = requestAnimationFrame(frame);
  }

  /* ------------------------------------------------------------------------
     Pointer / wheel / keyboard
     ------------------------------------------------------------------------ */

  body.addEventListener("pointerdown", (event) => {
    if (event.button !== undefined && event.button !== 0) return;
    state.dragging = true;
    state.drag = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      tiltX: state.targetTiltX,
      tiltY: state.targetTiltY,
    };
    state.lastDrag = performance.now();
    body.setPointerCapture?.(event.pointerId);
  });

  body.addEventListener("pointermove", (event) => {
    const rect = body.getBoundingClientRect();
    state.pointerX = clamp(((event.clientX - rect.left) / rect.width) * 2 - 1, -1, 1);
    state.pointerY = clamp(((event.clientY - rect.top) / rect.height) * 2 - 1, -1, 1);

    if (!state.dragging || !state.drag || event.pointerId !== state.drag.id) return;

    state.targetTiltY = clamp(
      state.drag.tiltY + (event.clientX - state.drag.x) * 0.16,
      -18,
      18
    );
    state.targetTiltX = clamp(
      state.drag.tiltX + (event.clientY - state.drag.y) * 0.11,
      -12,
      12
    );
    state.lastDrag = performance.now();
  });

  function endDrag(event) {
    if (!state.dragging) return;
    state.dragging = false;
    state.drag = null;
    state.lastDrag = performance.now();
    if (event && body.hasPointerCapture?.(event.pointerId)) {
      body.releasePointerCapture(event.pointerId);
    }
  }

  body.addEventListener("pointerup", endDrag);
  body.addEventListener("pointercancel", endDrag);
  body.addEventListener("pointerleave", () => {
    if (!state.dragging) {
      state.pointerX = 0;
      state.pointerY = 0;
    }
  });

  body.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      const factor = Math.exp(-event.deltaY * 0.0012);
      state.targetScale = clamp(state.targetScale * factor, 0.78, 1.35);
    },
    { passive: false }
  );

  body.addEventListener("dblclick", () => resetView());

  function resetView() {
    state.targetTiltX = 0;
    state.targetTiltY = 0;
    state.targetScale = 1;
    state.pointerX = 0;
    state.pointerY = 0;
  }

  resetButton.addEventListener("click", resetView);

  window.addEventListener("keydown", (event) => {
    if (event.code === "Space") {
      const target = event.target;
      if (target instanceof HTMLElement && target.closest("button, input, label")) {
        return;
      }
      event.preventDefault();
      togglePlay();
    } else if (event.key === "r" || event.key === "R") {
      resetView();
    }
  });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden && state.playing) {
      if (state.mode === "audio") {
        audio.pause();
      } else {
        pauseDemo();
      }
    }
  });

  /* ------------------------------------------------------------------------
     Boot
     ------------------------------------------------------------------------ */

  function scheduleGlitch() {
    if (reduceMotion) return;
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
    setLine(0);
    updateProgress();
    rafId = requestAnimationFrame(frame);
    scheduleGlitch();
  }

  boot();

  window.addEventListener("pagehide", () => {
    cancelAnimationFrame(rafId);
    window.clearTimeout(glitchTimer);
    if (state.audioUrl) URL.revokeObjectURL(state.audioUrl);
  });
})();


