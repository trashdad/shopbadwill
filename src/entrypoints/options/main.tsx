import { render } from 'preact';
import { browser } from 'wxt/browser';

import { createMessagingClient } from '../../messaging/client';
import { App } from './App';
import { loadSections } from './registry';
import './style.css';

const sections = loadSections(import.meta.glob('./sections/*/index.tsx', { eager: true }));
const root = document.getElementById('app');
if (root !== null) render(<App client={createMessagingClient(browser.runtime)} sections={sections} />, root);
