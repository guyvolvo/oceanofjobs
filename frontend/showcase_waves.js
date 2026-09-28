// The landing page's showcase background: slow grained waves in three
// colours on black, drawn live on a canvas. A plain WebGL take on
// ShaderGradient's "waterPlane" (the settings it was matched to are in
// WAVES below) without React or three.js, so it costs one small script.
// A noise field is the water's height; the colours run across it along
// the tilted plane, a light from the upper left shades its slopes, and
// fresh grain goes over every frame. Draws only while the section is on
// screen and the tab is visible, at 30 frames a second. Without WebGL
// the section keeps its CSS gradient.
(function () {
  const canvas = document.querySelector(".showcase-waves");
  if (!canvas) return;
  const gl = canvas.getContext("webgl", { antialias: false, alpha: false, powerPreference: "low-power" });
  if (!gl) { canvas.remove(); return; }

  const WAVES = {
    color1: "#606080",
    color2: "#2fae4c",
    color3: "#212121",
    speed: 0.3,       // uSpeed
    density: 1.5,     // uDensity
    strength: 1.5,    // uStrength
    rotation: -60,    // rotationZ, degrees
    startTime: 8,     // uTime
    grain: 0.09,
  };

  const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);

  const VERT = `
    attribute vec2 pos;
    void main() { gl_Position = vec4(pos, 0.0, 1.0); }`;

  // Simplex noise by Ashima Arts / Stefan Gustavson (MIT).
  const FRAG = `
    precision highp float;
    uniform vec2 res;
    uniform float t;
    uniform vec3 c1, c2, c3;
    uniform float density, strength, rot, grain;

    vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
    vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
    vec4 permute(vec4 x) { return mod289(((x * 34.0) + 1.0) * x); }
    vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }
    float snoise(vec3 v) {
      const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
      const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
      vec3 i = floor(v + dot(v, C.yyy));
      vec3 x0 = v - i + dot(i, C.xxx);
      vec3 g = step(x0.yzx, x0.xyz);
      vec3 l = 1.0 - g;
      vec3 i1 = min(g.xyz, l.zxy);
      vec3 i2 = max(g.xyz, l.zxy);
      vec3 x1 = x0 - i1 + C.xxx;
      vec3 x2 = x0 - i2 + C.yyy;
      vec3 x3 = x0 - D.yyy;
      i = mod289(i);
      vec4 p = permute(permute(permute(
        i.z + vec4(0.0, i1.z, i2.z, 1.0)) + i.y + vec4(0.0, i1.y, i2.y, 1.0)) + i.x + vec4(0.0, i1.x, i2.x, 1.0));
      float n_ = 0.142857142857;
      vec3 ns = n_ * D.wyz - D.xzx;
      vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
      vec4 x_ = floor(j * ns.z);
      vec4 y_ = floor(j - 7.0 * x_);
      vec4 x = x_ * ns.x + ns.yyyy;
      vec4 y = y_ * ns.x + ns.yyyy;
      vec4 h = 1.0 - abs(x) - abs(y);
      vec4 b0 = vec4(x.xy, y.xy);
      vec4 b1 = vec4(x.zw, y.zw);
      vec4 s0 = floor(b0) * 2.0 + 1.0;
      vec4 s1 = floor(b1) * 2.0 + 1.0;
      vec4 sh = -step(h, vec4(0.0));
      vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
      vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
      vec3 p0 = vec3(a0.xy, h.x);
      vec3 p1 = vec3(a0.zw, h.y);
      vec3 p2 = vec3(a1.xy, h.z);
      vec3 p3 = vec3(a1.zw, h.w);
      vec4 norm = taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
      p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
      vec4 m = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
      m = m * m;
      return 42.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
    }

    float height(vec2 p) {
      return snoise(vec3(p * density * 0.55, t * 0.22)) * strength
           + snoise(vec3(p * density * 1.3 + 7.0, t * 0.3)) * strength * 0.25;
    }

    float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }

    void main() {
      vec2 p = (gl_FragCoord.xy - 0.5 * res) / res.y;
      float a = radians(rot);
      p = mat2(cos(a), sin(a), -sin(a), cos(a)) * p;

      float h = height(p);
      vec2 e = vec2(0.004, 0.0);
      vec3 n = normalize(vec3(height(p - e.xy) - height(p + e.xy),
                              height(p - e.yx) - height(p + e.yx), 0.05));

      // Colour along the plane, pushed about by the waves.
      float v = clamp(0.5 + 0.34 * p.x + 0.16 * h, 0.0, 1.0);
      vec3 col = mix(c1, c2, smoothstep(0.22, 0.6, v));
      col = mix(col, c3, smoothstep(0.62, 0.98, v));

      // Light from the upper left, a soft sheen on the crests.
      vec3 L = normalize(vec3(-0.5, 0.6, 0.65));
      float diff = clamp(dot(n, L), 0.0, 1.0);
      float spec = pow(clamp(dot(reflect(-L, n), vec3(0.0, 0.0, 1.0)), 0.0, 1.0), 24.0);
      col *= 0.55 + 0.75 * diff;
      col += spec * 0.1;

      // Falls away into the black ground at the edges.
      vec2 q = gl_FragCoord.xy / res - 0.5;
      col *= smoothstep(1.05, 0.25, length(q * vec2(1.0, 1.6)));

      col += (hash(gl_FragCoord.xy + fract(t * 7.13) * 91.7) - 0.5) * grain;
      gl_FragColor = vec4(col, 1.0);
    }`;

  function shader(type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    return gl.getShaderParameter(s, gl.COMPILE_STATUS) ? s : null;
  }
  const vs = shader(gl.VERTEX_SHADER, VERT), fs = shader(gl.FRAGMENT_SHADER, FRAG);
  if (!vs || !fs) { canvas.remove(); return; }
  const prog = gl.createProgram();
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) { canvas.remove(); return; }
  gl.useProgram(prog);

  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, "pos");
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

  const u = (name) => gl.getUniformLocation(prog, name);
  gl.uniform3fv(u("c1"), hex(WAVES.color1));
  gl.uniform3fv(u("c2"), hex(WAVES.color2));
  gl.uniform3fv(u("c3"), hex(WAVES.color3));
  gl.uniform1f(u("density"), WAVES.density);
  gl.uniform1f(u("strength"), WAVES.strength);
  gl.uniform1f(u("rot"), WAVES.rotation);
  gl.uniform1f(u("grain"), WAVES.grain);
  const uRes = u("res"), uT = u("t");

  // One device pixel per CSS pixel at most, as ShaderGradient's
  // pixelDensity 1: the grain is the texture, so extra pixels buy little.
  function resize() {
    const w = Math.max(1, Math.round(canvas.clientWidth)), h = Math.max(1, Math.round(canvas.clientHeight));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      gl.viewport(0, 0, w, h);
      gl.uniform2f(uRes, w, h);
    }
  }

  let onScreen = false, raf = 0, last = 0, clock = WAVES.startTime, prev = 0;
  function frame(now) {
    raf = requestAnimationFrame(frame);
    if (now - last < 1000 / 30) return;
    clock += prev ? Math.min(now - prev, 100) / 1000 * WAVES.speed * 3.3 : 0;
    prev = now;
    last = now;
    resize();
    gl.uniform1f(uT, clock);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
  function update() {
    const run = onScreen && !document.hidden;
    if (run && !raf) { prev = 0; raf = requestAnimationFrame(frame); }
    if (!run && raf) { cancelAnimationFrame(raf); raf = 0; }
  }
  new IntersectionObserver(([entry]) => { onScreen = entry.isIntersecting; update(); }).observe(canvas);
  document.addEventListener("visibilitychange", update);
})();
