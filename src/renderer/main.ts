import { provideZonelessChangeDetection } from '@angular/core';
import { bootstrapApplication } from '@angular/platform-browser';

import { APP_NAME } from '../shared/app-config';
import { AppComponent } from './app/app';

document.title = APP_NAME;

// First paint: the main process applied the saved theme to nativeTheme before this window was
// created, so prefers-color-scheme already reflects it (the OS theme for "system", else the override).
document.documentElement.dataset['theme'] = window.matchMedia('(prefers-color-scheme: dark)').matches
  ? 'dark'
  : 'light';

void bootstrapApplication(AppComponent, {
  providers: [provideZonelessChangeDetection()],
}).catch((err: unknown) => {
  // Nothing has rendered yet at this point, so put the failure somewhere visible.
  console.error('Bootstrap failed', err);
  document.body.textContent = `Failed to start: ${err instanceof Error ? err.message : String(err)}`;
});
