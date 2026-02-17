const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

app.post('/api/tts', (req, res) => {
  const { text, voice } = req.body;
  if (!text) return res.status(400).send('Missing text');

  // Use piper with proper model path
  const piper = spawn('piper', ['-m', process.env.PIPER_MODEL || '/models/en_US-amy-medium.onnx', '--output_file', '/tmp/output.wav'], {
    stdio: ['pipe', 'inherit', 'inherit']
  });

  piper.stdin.write(text);
  piper.stdin.end();

  piper.on('close', (code) => {
    if (code !== 0) return res.status(500).send('Piper failed');

    const wav = fs.readFileSync('/tmp/output.wav');
    res.set('Content-Type', 'audio/wav');
    res.send(wav);
    fs.unlinkSync('/tmp/output.wav');
  });
});

app.listen(5002, () => console.log('Piper TTS server listening on port 5002'));