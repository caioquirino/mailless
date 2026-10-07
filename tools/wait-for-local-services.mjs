// Waits until the containers from docker-compose.yml accept connections, so
// tests that start right after `docker compose up` do not find them missing.
const services = {
  'DynamoDB Local': process.env.DYNAMODB_ENDPOINT ?? 'http://127.0.0.1:8000',
  'S3 stand-in': process.env.S3_ENDPOINT ?? 'http://127.0.0.1:9090',
};
const deadline = Date.now() + 60_000;

for (const [name, url] of Object.entries(services)) {
  for (;;) {
    try {
      // Any HTTP response, even an error status, means the service is listening.
      await fetch(url, { signal: AbortSignal.timeout(2_000) });
      break;
    } catch {
      if (Date.now() > deadline) {
        console.error(`${name} did not become reachable at ${url}`);
        process.exit(1);
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}
console.log('Local services are ready.');
