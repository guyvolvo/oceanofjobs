// The homepage showcase's background: a 15s gradient loop rendered in
// ShaderGradient, served from /media/ with a year's immutable cache (it
// never ships through the deploy's sync; a new render gets a new -vN
// name). Desktop only, and only once the section is near the screen:
// the files are 25 MB (WebM, tried first) and 43 MB (MP4, for browsers
// without VP9), and the phone layout never shows them. The poster is the
// first frame, so the card is never empty while it loads. Paused while
// off screen.
(function () {
  const video = document.querySelector(".showcase-video");
  if (!video) return;
  const desktop = window.matchMedia("(min-width: 721px)");
  const SOURCES = [
    ["/media/showcase-gradient-v1.webm", "video/webm"],
    ["/media/showcase-gradient-v1.mp4", "video/mp4"],
  ];
  let loaded = false;
  function load() {
    if (loaded) return;
    loaded = true;
    video.muted = true;
    for (const [src, type] of SOURCES) {
      const s = document.createElement("source");
      s.src = src;
      s.type = type;
      video.appendChild(s);
    }
    video.load();
  }
  new IntersectionObserver(([entry]) => {
    if (!desktop.matches) return;
    if (entry.isIntersecting) {
      load();
      video.play().catch(() => {});
    } else {
      video.pause();
    }
  }, { rootMargin: "200px" }).observe(video);
})();
