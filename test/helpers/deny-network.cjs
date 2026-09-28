const net = require('node:net');
const tls = require('node:tls');
const http = require('node:http');
const https = require('node:https');
const deny = () => { throw new Error('Unexpected network request in test subprocess'); };
const connect = net.connect;
const createConnection = net.createConnection;
// TSX uses a local Unix-domain IPC socket; block remote sockets, not IPC.
net.connect = function (...args) { return typeof args[0] === 'string' || args[0]?.path ? connect.apply(this, args) : deny(); };
net.createConnection = function (...args) { return typeof args[0] === 'string' || args[0]?.path ? createConnection.apply(this, args) : deny(); };
tls.connect = deny;
http.request = deny;
http.get = deny;
https.request = deny;
https.get = deny;
globalThis.fetch = deny;
