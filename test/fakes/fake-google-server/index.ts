// `pnpm fake:google`: runs the fake Google server on 127.0.0.1:8788.
import { startFakeGoogle } from './server';

const port = Number(process.env['FAKE_GOOGLE_PORT'] ?? 8788);
const fake = await startFakeGoogle({ port });
console.log(`fake-google listening on ${fake.url}`);
const stop = () => {
  void fake.close().then(() => process.exit(0));
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
