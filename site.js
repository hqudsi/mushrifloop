// MushrifLoop — the project page. The only script: blocks below the first screen rise into place the first time
// they scroll into view. Without it (or with reduced motion) the page is whole and still.
(() => {
  if (!('IntersectionObserver' in window) || matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  const blocks = document.querySelectorAll(
    'main section .wrap > :not(.steps, .facts, .holds, .install, .tour), .steps > li, .facts > li, .holds > li, .install > *, .tour > *',
  );
  const settle = (event) => {
    if (event.target !== event.currentTarget) return;
    const block = event.currentTarget;
    block.classList.remove('wait', 'in');
    block.style.transitionDelay = '';
    block.removeEventListener('transitionend', settle);
  };
  const seen = new IntersectionObserver(
    (entries) => {
      const together = new Map();
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const block = entry.target;
        // Siblings that arrive together (a row of cards, a heading and its line) follow one another instead of moving as one.
        const place = together.get(block.parentElement) ?? 0;
        together.set(block.parentElement, place + 1);
        block.style.transitionDelay = `${Math.min(place, 5) * 80}ms`;
        block.addEventListener('transitionend', settle);
        block.classList.add('in');
        seen.unobserve(block);
      }
    },
    { rootMargin: '0px 0px -8% 0px', threshold: 0.1 },
  );
  for (const block of blocks) {
    // What is already on the screen (or above it) stays as it is; only what is still below waits.
    if (block.getBoundingClientRect().top < innerHeight * 0.92) continue;
    block.classList.add('wait');
    seen.observe(block);
  }
})();
