// ============================================================
// ShadowCharacter — procedural Three.js shadow entity
// Hooded dark figure with glowing eyes, layered robe, wisps.
// Animations are procedural: Idle (breathe), Walk (stride bob),
// Float (drag/drop rise). No external models needed.
// ============================================================

import * as THREE from 'three';

function contextAlive() {
  try {
    return !!(chrome.runtime && chrome.runtime.id);
  } catch (err) {
    return false;
  }
}

export class ShadowCharacter {
  constructor(container) {
    this.container = container;
    this.position = { x: window.innerWidth - 280, y: window.innerHeight - 380 };
    this.isMoving = false;
    this.currentEmotion = 'idle';
    this._destroyed = false;
    this._ambientInterval = null;

    this._renderer = null;
    this._scene = null;
    this._camera = null;
    this._animationId = null;
    this._t = 0;

    this._anim = 'Idle';
    this._animBlend = 0;

    this._group = null;
    this._body = null;
    this._head = null;
    this._eyes = [];
    this._capeLayers = [];
    this._wisps = null;
    this._loaded = false;

    this._dragging = false;
    this._dragOffsetX = 0;
    this._dragOffsetY = 0;
    this._dragX = 0;
    this._dragY = 0;
    this._dragBound = false;

    this.EMOTION_COLORS = {
      idle:       new THREE.Color(0x7a2ff0),
      thinking:   new THREE.Color(0xa855f7),
      distressed: new THREE.Color(0xff2200),
      calm:       new THREE.Color(0x7a2ff0),
      excited:    new THREE.Color(0xffaa00),
      sad:        new THREE.Color(0x2266ff),
      angry:      new THREE.Color(0xff0000),
    };
  }

  async arise() {
    if (this._destroyed) return;
    this._setupContainer();
    this._setupRenderer();
    if (!this._loaded) this._buildCharacter();
    this._setPosition(window.innerWidth - 280, window.innerHeight - 380);
    await this._animateIn();
    this._setAnim('Idle');
    this._startRenderLoop();
    this._startAmbientMovement();
    this._setupDrag();
  }

  async silentShow() {
    if (this._destroyed) return;
    this._setupContainer();
    this._setupRenderer();
    if (!this._loaded) this._buildCharacter();
    const restored = await this._restorePosition();
    if (!restored) this._setPosition(window.innerWidth - 280, window.innerHeight - 380);
    this.container.style.opacity = '1';
    this._setAnim('Idle');
    this._startRenderLoop();
    this._startAmbientMovement();
    this._setupDrag();
  }

  async disappear() {
    await this._animateOut();
    this.container.style.display = 'none';
    this._stopAmbientMovement();
    this._stopRenderLoop();
    this._teardownDrag();
  }

  destroy() {
    this._destroyed = true;
    this._stopAmbientMovement();
    this._stopRenderLoop();
    this._teardownDrag();
    if (this._renderer) { this._renderer.dispose(); this._renderer = null; }
    if (this._scene) { this._scene.clear(); this._scene = null; }
    document.getElementById('shadow-keyframes')?.remove();
  }

  setThinking(active) {
    if (!this._pointLight) return;
    if (active) {
      this._pointLight.color.set(0xa855f7);
      this._pointLight.intensity = 3.2;
      this._eyes.forEach(e => e.material.color.set(0xd8b4fe));
    } else {
      this._applyEmotionLook();
    }
  }

  setListening(active) {
    if (!this._pointLight) return;
    if (active) {
      this._pointLight.color.set(0xcc44ff);
      this._pointLight.intensity = 2.6;
      this._eyes.forEach(e => e.material.color.set(0xffffff));
    } else {
      this._applyEmotionLook();
    }
  }

  reactToEmotion(emotionalState) {
    const { dominantEmotion, intensity } = emotionalState || {};
    this.currentEmotion = dominantEmotion || 'idle';
    this._applyEmotionLook(intensity || 0);
    if ((intensity || 0) > 0.7) this._moveToward(this._getFocusPoint());
  }

  attendToContent() {
    if (this._destroyed || this._dragging) return;

    const cx = window.innerWidth / 2;
    const cy = window.innerHeight / 2;
    let el = document.elementFromPoint(cx, cy);

    while (el && el !== document.body) {
      const r = el.getBoundingClientRect();
      if (r.width > 300 && r.height > 150) break;
      el = el.parentElement;
    }

    const rect = (el && el !== document.body)
      ? el.getBoundingClientRect()
      : { left: cx - 150, width: 300 };

    const targetX = Math.max(10, Math.min(
      window.innerWidth - 290,
      rect.left + rect.width / 2 - 140
    ));

    this._moveTo(targetX, window.innerHeight - 380, 1400);
  }

  _applyEmotionLook(intensity = 0) {
    const color = this.EMOTION_COLORS[this.currentEmotion] || this.EMOTION_COLORS.idle;
    if (this._pointLight) {
      this._pointLight.color.copy(color);
      this._pointLight.intensity = 1.8 + intensity * 1.5;
    }
    this._eyes.forEach(e => e.material.color.copy(color).lerp(new THREE.Color(0xffffff), 0.5));
  }

  _buildCharacter() {
    this._group = new THREE.Group();

    const robeMat = new THREE.MeshStandardMaterial({
      color: 0x0a0a14, roughness: 0.9, metalness: 0.1,
    });
    const darkMat = new THREE.MeshStandardMaterial({
      color: 0x05050c, roughness: 1.0, metalness: 0.0,
    });

    const robeLayers = [
      { r: 0.42, h: 1.15, y: 0.55, seg: 7 },
      { r: 0.36, h: 1.0,  y: 0.75, seg: 6 },
      { r: 0.30, h: 0.85, y: 0.95, seg: 5 },
    ];
    this._capeLayers = [];
    robeLayers.forEach((l, i) => {
      const geo = new THREE.ConeGeometry(l.r, l.h, l.seg, 1, true);
      const pos = geo.attributes.position;
      for (let v = 0; v < pos.count; v++) {
        if (pos.getY(v) < -l.h * 0.4) {
          pos.setY(v, pos.getY(v) + (Math.random() - 0.5) * 0.18);
          pos.setX(v, pos.getX(v) * (1 + (Math.random() - 0.5) * 0.15));
        }
      }
      geo.computeVertexNormals();
      const mesh = new THREE.Mesh(geo, i === 0 ? darkMat : robeMat);
      mesh.position.y = l.y;
      mesh.rotation.y = i * 0.4;
      this._group.add(mesh);
      this._capeLayers.push(mesh);
    });
    this._body = this._capeLayers[0];

    const shoulderGeo = new THREE.SphereGeometry(0.16, 8, 6);
    [-1, 1].forEach(side => {
      const sh = new THREE.Mesh(shoulderGeo, robeMat);
      sh.position.set(side * 0.26, 1.28, 0);
      sh.scale.set(1, 0.7, 0.9);
      this._group.add(sh);
    });

    const hoodGeo = new THREE.SphereGeometry(0.24, 12, 10, 0, Math.PI * 2, 0, Math.PI * 0.75);
    const hood = new THREE.Mesh(hoodGeo, robeMat);
    hood.position.y = 1.52;
    hood.rotation.x = 0.25;
    this._group.add(hood);

    const faceGeo = new THREE.SphereGeometry(0.17, 10, 8);
    const faceMat = new THREE.MeshBasicMaterial({ color: 0x000000 });
    this._head = new THREE.Mesh(faceGeo, faceMat);
    this._head.position.set(0, 1.48, 0.05);
    this._group.add(this._head);

    const eyeGeo = new THREE.SphereGeometry(0.028, 8, 6);
    const mkEye = (x) => {
      const mat = new THREE.MeshBasicMaterial({ color: 0xc084fc });
      const eye = new THREE.Mesh(eyeGeo, mat);
      eye.position.set(x, 1.51, 0.19);
      eye.scale.set(1.6, 0.55, 0.6);
      this._group.add(eye);
      this._eyes.push(eye);
      const glowMat = new THREE.MeshBasicMaterial({ color: 0x7a2ff0, transparent: true, opacity: 0.35 });
      const glow = new THREE.Mesh(new THREE.SphereGeometry(0.05, 8, 6), glowMat);
      glow.position.copy(eye.position);
      glow.position.z -= 0.01;
      this._group.add(glow);
    };
    mkEye(-0.07);
    mkEye(0.07);

    const wispCount = 40;
    const wispGeo = new THREE.BufferGeometry();
    const wispPos = new Float32Array(wispCount * 3);
    this._wispSeeds = [];
    for (let i = 0; i < wispCount; i++) {
      const angle = Math.random() * Math.PI * 2;
      const radius = 0.35 + Math.random() * 0.35;
      const h = Math.random() * 1.6;
      wispPos[i * 3] = Math.cos(angle) * radius;
      wispPos[i * 3 + 1] = h;
      wispPos[i * 3 + 2] = Math.sin(angle) * radius;
      this._wispSeeds.push({ angle, radius, h, speed: 0.2 + Math.random() * 0.5 });
    }
    wispGeo.setAttribute('position', new THREE.BufferAttribute(wispPos, 3));
    const wispMat = new THREE.PointsMaterial({
      color: 0x7a2ff0, size: 0.035, transparent: true, opacity: 0.6,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    this._wisps = new THREE.Points(wispGeo, wispMat);
    this._group.add(this._wisps);

    const discGeo = new THREE.CircleGeometry(0.4, 24);
    const discMat = new THREE.MeshBasicMaterial({ color: 0x7a2ff0, transparent: true, opacity: 0.12 });
    const disc = new THREE.Mesh(discGeo, discMat);
    disc.rotation.x = -Math.PI / 2;
    disc.position.y = 0.01;
    this._group.add(disc);

    this._group.position.y = -0.85;
    this._scene.add(this._group);
    this._loaded = true;
    console.log('[Shadow] Procedural character built.');
  }

  _setAnim(name, instant = false) {
    if (this._anim === name) return;
    this._anim = name;
    // Keep current blend value for smooth crossfade instead of hard reset
    if (instant) this._animBlend = 0;
    // else _animBlend stays where it is and blends naturally into new anim
  }

  _updateAnim(dt) {
    if (!this._group) return;
    this._t += dt;
    this._animBlend = Math.min(1, this._animBlend + dt * 2.5);
    const t = this._t;
    const b = this._animBlend;

    if (this._anim === 'Idle') {
      const breathe = 1 + Math.sin(t * 1.6) * 0.015;
      this._capeLayers.forEach((c, i) => { c.scale.set(breathe, 1, breathe); c.rotation.y += dt * 0.02 * (i + 1); });
      this._group.position.y = -0.85 + Math.sin(t * 0.8) * 0.015 * b;
      this._group.rotation.z = Math.sin(t * 0.5) * 0.01 * b;
      this._group.rotation.x = 0;
    } else if (this._anim === 'Walk') {
      this._group.position.y = -0.85 + Math.abs(Math.sin(t * 6)) * 0.05 * b;
      this._group.rotation.z = Math.sin(t * 6) * 0.04 * b;
      this._group.rotation.x = 0.08 * b;
      this._capeLayers.forEach((c, i) => { c.rotation.y += dt * 0.3 * (i + 1); });
    } else if (this._anim === 'Float') {
      this._group.position.y = -0.85 + (0.15 + Math.sin(t * 1.2) * 0.05) * b;
      this._group.rotation.z = Math.sin(t * 0.8) * 0.03;
      this._group.rotation.x = -0.05 * b;
      this._capeLayers.forEach((c, i) => { c.rotation.y += dt * 0.6 * (i + 1); });
    }

    const flicker = 0.85 + Math.sin(t * 7.3) * 0.08 + Math.sin(t * 13.7) * 0.07;
    this._eyes.forEach(e => { e.material.opacity = flicker; e.material.transparent = true; });

    if (this._wisps) {
      const pos = this._wisps.geometry.attributes.position;
      const speedMult = this._anim === 'Float' ? 2.2 : 1;
      this._wispSeeds.forEach((s, i) => {
        s.angle += dt * s.speed * speedMult;
        pos.setX(i, Math.cos(s.angle) * s.radius);
        pos.setZ(i, Math.sin(s.angle) * s.radius);
        pos.setY(i, s.h + Math.sin(t * s.speed * 2 + i) * 0.06);
      });
      pos.needsUpdate = true;
    }
  }

  // ── Drag: free movement anywhere on screen ───────────────
  _setupDrag() {
    if (this._dragBound) return;
    this._dragBound = true;

    this._onPointerDown = (e) => {
      e.preventDefault();
      e.stopPropagation();
      this._dragging = true;
      this._dragOffsetX = e.clientX - this.position.x;
      this._dragOffsetY = e.clientY - this.position.y;
      this._dragX = this.position.x;
      this._dragY = this.position.y;
      this.container.style.transition = 'none';
      this._stopAmbientMovement();
      this._setAnim('Float');
      // Disable canvas pointer capture so window gets all move events
      if (this._renderer?.domElement) {
        this._renderer.domElement.style.pointerEvents = 'none';
      }
      // Prevent page text selection during drag
      document.body.style.userSelect = 'none';
    };

    this._onPointerMove = (e) => {
      if (!this._dragging) return;
      this._dragX = e.clientX - this._dragOffsetX;
      this._dragY = e.clientY - this._dragOffsetY;
      const cx = Math.max(10, Math.min(window.innerWidth - 290, this._dragX));
      const cy = Math.max(-300, Math.min(window.innerHeight - 100, this._dragY));
      this.container.style.left = `${cx}px`;
      this.container.style.top = `${cy}px`;
    };

    this._onPointerUp = () => {
      if (!this._dragging) return;
      this._dragging = false;

      // Re-enable canvas pointer events
      if (this._renderer?.domElement) {
        this._renderer.domElement.style.pointerEvents = 'auto';
      }
      document.body.style.userSelect = '';

      // Snap to bottom of viewport at horizontal drop position
      const dropX = Math.max(10, Math.min(window.innerWidth - 290, this._dragX));
      const dropY = window.innerHeight - 380;

      this.position = { x: dropX, y: dropY };
      this.container.style.transition = 'top 0.45s cubic-bezier(0.34, 1.56, 0.64, 1), left 0.2s ease';
      this._setPosition(dropX, dropY);

      this._setAnim('Float');
      setTimeout(() => {
        if (!this._destroyed) {
          this._setAnim('Idle');
          this._startAmbientMovement();
        }
      }, 2500);

      this._persistPosition();
    };

    const canvas = this._renderer?.domElement;
    if (canvas) {
      canvas.style.pointerEvents = 'auto';
      canvas.style.cursor = 'grab';
      canvas.addEventListener('pointerdown', this._onPointerDown);
    }
    this.container.style.pointerEvents = 'auto';
    this.container.addEventListener('pointerdown', this._onPointerDown);
    window.addEventListener('pointermove', this._onPointerMove);
    window.addEventListener('pointerup', this._onPointerUp);
  }

  _teardownDrag() {
    const canvas = this._renderer?.domElement;
    if (canvas && this._onPointerDown) canvas.removeEventListener('pointerdown', this._onPointerDown);
    if (this._onPointerDown) this.container.removeEventListener('pointerdown', this._onPointerDown);
    if (this._onPointerMove) window.removeEventListener('pointermove', this._onPointerMove);
    if (this._onPointerUp) window.removeEventListener('pointerup', this._onPointerUp);
    this._dragBound = false;
  }

  _setupContainer() {
    if (!document.getElementById('shadow-keyframes')) {
      const style = document.createElement('style');
      style.id = 'shadow-keyframes';
      style.textContent = `
        #shadow-canvas { display: block; background: transparent; cursor: grab; }
        #shadow-canvas:active { cursor: grabbing; }
      `;
      document.head.appendChild(style);
    }
    this.container.style.position = 'fixed';
    this.container.style.width = '280px';
    this.container.style.height = '380px';
    this.container.style.zIndex = '2147483647';
    this.container.style.pointerEvents = 'auto';
    this.container.style.background = 'transparent';
    this.container.style.display = 'block';
    this.container.style.transition = 'opacity 0.6s ease, transform 0.6s cubic-bezier(0.34, 1.56, 0.64, 1)';
  }

  _setupRenderer() {
    if (this._renderer) return;

    this._scene = new THREE.Scene();
    this._scene.background = null;

    this._camera = new THREE.PerspectiveCamera(40, 280 / 380, 0.1, 100);
    this._camera.position.set(0, 0.55, 3.1);
    this._camera.lookAt(0, 0.45, 0);

    this._renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, premultipliedAlpha: false });
    this._renderer.setSize(280, 380);
    this._renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this._renderer.setClearColor(0x000000, 0);
    this._renderer.outputColorSpace = THREE.SRGBColorSpace;
    this._renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this._renderer.toneMappingExposure = 1.15;

    this._renderer.domElement.id = 'shadow-canvas';
    this._renderer.domElement.style.cssText = 'display:block;width:280px;height:380px;background:transparent;';
    this.container.appendChild(this._renderer.domElement);

    this._scene.add(new THREE.AmbientLight(0x1a1a2e, 0.6));

    this._pointLight = new THREE.PointLight(0x7a2ff0, 1.8, 8);
    this._pointLight.position.set(0, 1.6, 1.6);
    this._scene.add(this._pointLight);

    const rimLight = new THREE.DirectionalLight(0x2244ff, 1.0);
    rimLight.position.set(-2, 2.5, -2.5);
    this._scene.add(rimLight);

    const underGlow = new THREE.PointLight(0x7a2ff0, 0.8, 3);
    underGlow.position.set(0, -0.5, 0.5);
    this._scene.add(underGlow);
  }

  _startRenderLoop() {
    if (this._animationId) return;
    let last = performance.now();
    const tick = (now) => {
      if (this._destroyed) return;
      this._animationId = requestAnimationFrame(tick);
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;
      this._updateAnim(dt);
      if (this._renderer && this._scene && this._camera) {
        this._renderer.render(this._scene, this._camera);
      }
    };
    this._animationId = requestAnimationFrame(tick);
  }

  _stopRenderLoop() {
    if (this._animationId) { cancelAnimationFrame(this._animationId); this._animationId = null; }
  }

  _startAmbientMovement() {
    if (this._destroyed || this._ambientInterval) return;
    const scheduleNext = () => {
      this._ambientInterval = setTimeout(() => {
        if (this._destroyed || this._dragging) { scheduleNext(); return; }
        const dx = (Math.random() - 0.5) * 320;
        const newX = Math.max(10, Math.min(window.innerWidth - 290, this.position.x + dx));
        const newY = window.innerHeight - 380;
        this._moveTo(newX, newY, 2000);
        scheduleNext();
      }, 5000 + Math.random() * 4000);
    };
    scheduleNext();
  }

  _stopAmbientMovement() {
    clearTimeout(this._ambientInterval);
    this._ambientInterval = null;
  }

  _moveToward(point) {
    const targetX = Math.max(10, Math.min(window.innerWidth - 290, point.x - 140));
    const targetY = window.innerHeight - 380;
    this._moveTo(targetX, targetY, 1500);
  }

  _moveTo(x, y, duration = 1000) {
    if (this._dragging) return;
    this.isMoving = true;
    const startX = this.position.x;
    const startY = this.position.y;
    const startTime = performance.now();

    if (this._group) {
      const dx = x - startX;
      if (Math.abs(dx) > 5) {
        this._group.rotation.y = dx > 0 ? 0.35 : -0.35;
      }
    }

    this._setAnim('Walk');

    const animate = (now) => {
      if (this._destroyed || this._dragging) return;
      const t = Math.min((now - startTime) / duration, 1);
      const ease = 1 - Math.pow(1 - t, 3);
      this._setPosition(startX + (x - startX) * ease, startY + (y - startY) * ease);
      if (t < 1) {
        requestAnimationFrame(animate);
      } else {
        this.position = { x, y };
        this.isMoving = false;
        if (this._group) this._group.rotation.y = 0;
        this._setAnim('Idle');
        this._persistPosition();
      }
    };
    requestAnimationFrame(animate);
  }

  _setPosition(x, y) {
    this.container.style.left = `${x}px`;
    this.container.style.top = `${y}px`;
    this.container.style.bottom = 'auto';
    this.container.style.right = 'auto';
  }

  _persistPosition() {
    if (this._destroyed || !contextAlive()) return;
    try { chrome.storage.session.set({ shadowPosition: this.position }); } catch (err) {}
  }

  async _restorePosition() {
    if (this._destroyed || !contextAlive()) return false;
    try {
      const { shadowPosition } = await chrome.storage.session.get('shadowPosition');
      if (shadowPosition) {
        this.position = { x: shadowPosition.x, y: shadowPosition.y };
        this._setPosition(shadowPosition.x, shadowPosition.y);
        return true;
      }
    } catch (err) {}
    return false;
  }

  _getFocusPoint() {
    const focused = document.activeElement;
    if (focused && focused !== document.body) {
      const rect = focused.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    }
    return { x: window.innerWidth / 2, y: window.innerHeight / 2 };
  }

  async _animateIn() {
    this.container.style.opacity = '0';
    this.container.style.transform = 'scale(0.7) translateY(40px)';
    await this._wait(50);
    this.container.style.opacity = '1';
    this.container.style.transform = 'scale(1) translateY(0)';
    await this._wait(600);
  }

  async _animateOut() {
    this.container.style.transition = 'opacity 0.4s ease, transform 0.4s ease';
    this.container.style.opacity = '0';
    this.container.style.transform = 'scale(0.7) translateY(40px)';
    await this._wait(400);
  }

  _wait(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
}