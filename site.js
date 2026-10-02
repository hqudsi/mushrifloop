// MushrifLoop — the project page. The only script, and the page is whole without it:
//   1. blocks below the first screen rise into place the first time they scroll into view;
//   2. the app's screens take turns, six seconds each, until the visitor chooses one.
// With reduced motion neither happens.
(() => {
  if (!('IntersectionObserver' in window) || matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  // 1. The scroll-in.
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

  // 2. The screens' turns. The stylesheet times a turn (the `turn` animation on the chosen item, paused while the
  //    pointer is over the screens); when it ends, the next screen is chosen here. A choice by the visitor ends it.
  const tour = document.querySelector('.tour');
  if (!tour) return;
  const screens = [...tour.querySelectorAll('input[name="tour"]')];
  let chosenByVisitor = false;
  tour.addEventListener('change', (event) => {
    if (event.target.name !== 'tour') return;
    chosenByVisitor = true;
    tour.classList.remove('auto');
  });
  tour.addEventListener('animationend', (event) => {
    if (event.animationName !== 'turn' || chosenByVisitor) return;
    const now = screens.findIndex((screen) => screen.checked);
    screens[(now + 1) % screens.length].checked = true;
  });
  // Turns run only while the screens are in view, so a visitor meets them from the first one.
  new IntersectionObserver(
    ([entry]) => {
      if (!chosenByVisitor) tour.classList.toggle('auto', entry.isIntersecting);
    },
    { threshold: 0.35 },
  ).observe(tour);
})();
