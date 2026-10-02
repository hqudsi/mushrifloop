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
  // .live is set below: if it is already there, this script has run on the page once and must not run again.
  if (!tour || !rail || tour.classList.contains('live')) return;
  const screens = [...tour.querySelectorAll('input[name="tour"]')];
  const frames = [...rail.querySelectorAll('.frame')];

  // The turns' clock (used in 3): how much of the turn is spent, and the timer for the rest of it.
  const TURN = 6000;
  let inView = false;
  let held = false;
  let spent = 0;
  let since = 0;
  let clock = 0;
  const stopClock = () => {
    if (!clock) return;
    clearTimeout(clock);
    clock = 0;
    spent += performance.now() - since;
  };
  const runClock = () => {
    if (clock || chosenByVisitor || !inView || held || document.hidden) return;
    since = performance.now();
    clock = setTimeout(
      () => {
        clock = 0;
        spent = 0;
        const next = (screens.findIndex((screen) => screen.checked) + 1) % screens.length;
        screens[next].checked = true;
        bring(next);
        runClock();
      },
      Math.max(0, TURN - spent),
    );
  };
  let chosenByVisitor = false;
  const visitorChose = () => {
    chosenByVisitor = true;
    stopClock();
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

  // 3. The turns. One clock, here, counts a turn; the stylesheet only draws the time passing (the chosen item's
  //    mark, or its segment on a phone, fills in the same six seconds). The clock does not listen for the
  //    drawing to end: on one phone that came twice a turn and every second screen was skipped.
  if (still) return;
  const show = () => {
    if (!inView || document.hidden || chosenByVisitor) return;
    if (!tour.classList.contains('auto')) {
      // The drawing starts again from nothing when .auto comes back, so the clock does too.
      spent = 0;
      tour.classList.add('auto');
    }
    runClock();
  };
  const rest = () => {
    stopClock();
    spent = 0;
    tour.classList.remove('auto');
  };
  // Turns run only while the screens are in view (and the page is the one being looked at), so a visitor meets
  // them from the first one.
  new IntersectionObserver(
    ([entry]) => {
      inView = entry.isIntersecting;
      if (chosenByVisitor) return;
      if (inView) show();
      else rest();
    },
    { threshold: 0.35 },
  ).observe(tour);
  document.addEventListener('visibilitychange', () => {
    if (chosenByVisitor) return;
    if (document.hidden) rest();
    else show();
  });
  // A mouse over the screens holds the turn where it is; the clock and the drawing stop and go on together.
  tour.addEventListener('pointerenter', (event) => {
    if (event.pointerType !== 'mouse') return;
    held = true;
    tour.classList.add('held');
    stopClock();
  });
  tour.addEventListener('pointerleave', (event) => {
    if (event.pointerType !== 'mouse') return;
    held = false;
    tour.classList.remove('held');
    runClock();
  });
})();
