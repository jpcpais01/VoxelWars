const { chromium } = require('/opt/node-tools/node_modules/playwright');
const views = JSON.parse(process.argv[2]);
const out = process.argv[3];
(async () => {
  const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const p = await b.newPage({ viewport: { width: 768, height: 768 } });
  p.on('pageerror', (e) => console.log('ERR', e.message));
  await p.addInitScript((l) => localStorage.setItem('voxelwars.settings.v1', JSON.stringify({ quality: 'high', lighting: l })), views.lighting || 'golden');
  await p.goto('http://localhost:4173/?debug', { timeout: 120000 });
  await p.waitForFunction(() => window.vw && window.vw.world, null, { timeout: 300000 });
  await p.waitForTimeout(20000);
  await p.evaluate(() => {
    for (const el of document.querySelectorAll('body > *:not(canvas)')) if (el.tagName !== 'CANVAS' && !el.querySelector('canvas')) el.style.display = 'none';
  });
  await p.evaluate(() => {
    const r = window.vw.renderer;
    r.adapt = () => {};
    r.dynScale = 1;
    r.tiltShift = false;
    r.q = { ...r.q, dof: false };
    const orig = r.updateShadowCamera.bind(r);
    r.updateShadowCamera = () => window.__tgt && orig(window.__tgt);
    r.resize();
  });
  let i = 0;
  for (const v of views.shots) {
    await p.evaluate((v) => {
      const cam = window.vw.renderer.camera;
      cam.position.set = function () { return this; };
      cam.lookAt = function () {};
      const T = window.THREE_V3 || cam.position.constructor;
      Object.getPrototypeOf(cam.position).set.call(cam.position, v.p[0], v.p[1], v.p[2]);
      cam.fov = v.fov || 40; cam.updateProjectionMatrix();
      const m = new cam.matrix.constructor();
      const eye = cam.position, tgt = new T(v.t[0], v.t[1], v.t[2]), up = new T(0, 1, 0);
      m.lookAt(eye, tgt, up); cam.quaternion.setFromRotationMatrix(m);
      window.vw.renderer.focusTarget.copy(tgt); window.__tgt = tgt; window.vw.renderer.shadowExtent = v.se || 60;
    }, v);
    await p.waitForTimeout(v.wait || 25000);
    await p.screenshot({ path: `${out}-${i++}.png`, timeout: 300000 });
    console.log('shot', i);
  }
  await b.close();
})();
