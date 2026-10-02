// MushrifLoop — the project page. The only script, and the page is whole without it:
//   1. blocks below the first screen rise into place the first time they scroll into view;
//   2. on a phone the app's screens are a rail to swipe, and the words under it follow the screen in view;
//   3. the screens take turns, six seconds each, until the visitor chooses one.
// With reduced motion 1 and 3 do not happen.
(() => {
  const still = !('IntersectionObserver' in window) || matchMedia('(prefers-reduced-motion: reduce)').matches;

  // 1. The scroll-in.
  if (!still) {
    const blocks = document.querySelectorAll(
      'main section .wrap > :not(.steps, .facts, .holds, .install), .steps > li, .facts > li, .holds > li, .install > *',
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
  }

  const tour = document.querySelector('.tour');
  const rail = tour?.querySelector('.rail');
  if (!tour || !rail) return;
  const screens = [...tour.querySelectorAll('input[name="tour"]')];
  const frames = [...rail.querySelectorAll('.frame')];
  let chosenByVisitor = false;
  const visitorChose = () => {
    chosenByVisitor = true;
    tour.classList.remove('auto');
  };

  // 2. The rail. The stylesheet makes it one only on a narrow screen; elsewhere it does not scroll and this is idle.
  tour.classList.add('live');
  const place = (frame) => frame.offsetLeft - frames[0].offsetLeft;
  let movedHereUntil = 0;
  const bring = (index) => {
    if (rail.scrollWidth <= rail.clientWidth + 4) return;
    movedHereUntil = performance.now() + 1000;
    rail.scrollTo({ left: place(frames[index]), behavior: still ? 'auto' : 'smooth' });
  };
  let pending = false;
  rail.addEventListener(
    'scroll',
    () => {
      // A move of the rail that did not start here is the visitor's swipe: it ends the turns and chooses the screen.
      if (performance.now() < movedHereUntil || pending) return;
      visitorChose();
      pending = true;
      requestAnimationFrame(() => {
        pending = false;
        let nearest = 0;
        for (let i = 1; i < frames.length; i++) {
          if (Math.abs(place(frames[i]) - rail.scrollLeft) < Math.abs(place(frames[nearest]) - rail.scrollLeft)) nearest = i;
        }
        if (!screens[nearest].checked) screens[nearest].checked = true;
      });
    },
    { passive: true },
  );
  tour.addEventListener('change', (event) => {
    if (event.target.name !== 'tour') return;
    visitorChose();
    bring(screens.indexOf(event.target));
  });

  // 3. The turns. The stylesheet times a turn (the chosen item's mark, or its segment on a phone, fills in six
  //    seconds; the pointer over the screens holds it); when it ends, the next screen is chosen here.
  if (still) return;
  tour.addEventListener('animationend', (event) => {
    if (!event.animationName.startsWith('turn') || chosenByVisitor) return;
    const next = (screens.findIndex((screen) => screen.checked) + 1) % screens.length;
    screens[next].checked = true;
    bring(next);
  });
  // Turns run only while the screens are in view, so a visitor meets them from the first one.
  new IntersectionObserver(
    ([entry]) => {
      if (!chosenByVisitor) tour.classList.toggle('auto', entry.isIntersecting);
    },
    { threshold: 0.35 },
  ).observe(tour);
})();
