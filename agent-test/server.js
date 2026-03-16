const http = require('http');
const PORT = 4100;

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Agent-test-v2 server radi na portu ' + PORT);
});

server.listen(PORT, () => {
  console.log('Server listening on http://localhost:' + PORT);
});
