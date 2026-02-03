// server.js
require('dotenv').config(); 

const express = require("express");
const https = require("https");
const fs = require("fs");
const { initializeSignaling } = require("./signaling-server");


const {
    PORT,
    SSL_KEY_PATH,
    SSL_CERT_PATH,
    SSL_CA_PATH
} = process.env;

let options = {};
try {
    options = {
        key: fs.readFileSync(SSL_KEY_PATH),
        cert: fs.readFileSync(SSL_CERT_PATH),
        ca: fs.readFileSync(SSL_CA_PATH)
    };
    console.log("SSL 인증서 및 Root CA 로드 성공");
} catch (error) {
    console.log("SSL 인증서 파일 로드 실패", error.message);
    process.exit(1);    
}

const app = express();
const server = https.createServer(options, app);   

const ioOptions = {
    cors: {
        origin: "*",    
        methods: ["GET", "POST"],
        credentials: true 
    }
}

const httpsAgent = new https.Agent({
    ca: options.ca,
    checkServerIdentity: (hostname, httpsAgent) => {
    }
})

initializeSignaling(server, ioOptions, httpsAgent);

server.listen(PORT || 3000, "0.0.0.0", () => {
    console.log("Signaling server running on https://0.0.0.0:" + `${PORT || 3000}`);
})