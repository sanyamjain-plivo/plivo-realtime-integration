import { Client } from "plivo";
import WebSocket, { WebSocketServer } from 'ws';
import express from "express";
import http from 'http'
import { SessionUpdate } from "./sessionUpdate.js";
import dotenv from "dotenv";


dotenv.config();
const app = express()
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

let client;
const PORT = 5000;

const { OPENAI_API_KEY } = process.env

SessionUpdate.session.instructions = 'You are a helpful and a friendly AI assistant who loves to chat about anything the user is interested about.';
SessionUpdate.session.voice = 'alloy';



app.post("/webhook", (request, reply) => {
  // sending the conference xml to keep the call alive
  const PlivoXMLResponse = `<?xml version="1.0" encoding="UTF-8"?>
                          <Response>
                              <Conference>Audio Streaming conference</Conference>
                          </Response>`;

  // starting the Audio streaming through Plivo API
  client.calls.stream(
    request.body.CallUUID,
    `ws://${request.host}/media-stream`,
    {
      bidirectional: true,
      audioTrack: "inbound",
      streamTimeout: 86400,
      contentType: 'audio/x-mulaw;rate=8000'
    }
  ).then((response) => {
    console.log('Plivo Audio Streaming started successfully ', response)
  }).catch((e) => {
    console.log('error while starting Plivo Audio Streaminfg ', e)
  });

  reply.type('text/xml').send(PlivoXMLResponse);
})

server.on('upgrade', (request, socket, head) => {
  if (request.url === '/media-stream') {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  } else {
    socket.destroy();
  }
});

const sendSessionUpdate = (realtimeWS) => {
  realtimeWS.send(JSON.stringify(SessionUpdate))
}

const itemForFunctionOutput = (arg, itemId, callId) => {
  const sum = parseInt(arg.num1) + parseInt(arg.num2)
  const conversationItem = {
    type: "conversation.item.create",
    previous_item_id: null,
    item: {
      id: itemId,
      type: "function_call_output",
      call_id: callId,
      output: sum.toString(),
    }
  }
  return conversationItem;
}

const startRealtimeWSConnection = (plivoWS) => {
  const realtimeWS = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01', {
    headers: {
      "Authorization": "Bearer " + OPENAI_API_KEY,
      "OpenAI-Beta": "realtime=v1",
    }
  })

  realtimeWS.on('open', () => {
    console.log('open ai websocket connected')
    setTimeout(() => {
      sendSessionUpdate(realtimeWS)
    }, 250)
  })

  realtimeWS.on('close', () => {
    console.log('Disconnected from the openAI Realtime API')
  });

  realtimeWS.on('error', (error) => {
    console.log('Error in the OpenAi Websocket: ', error)
  })

  realtimeWS.on('message', (message) => {
    try {
      const response = JSON.parse(message)

      switch (response.type) {
        case 'session.updated':
          console.log('session updated successfully')
          break;
        case 'input_audio_buffer.speech_started':
          console.log('speech is started')
          const data = {
            "type": "response.cancel"
          }
          realtimeWS.send(JSON.stringify(data))
          break;
        case 'error':
          console.log('error received in response ', response)
          break;
        case 'response.audio.delta':
          const audioDelta = {
            event: 'playAudio',
            media: {
              contentType: 'audio/x-mulaw',
              sampleRate: 8000,
              payload: Buffer.from(response.delta, 'base64').toString('base64')
            }
          }
          plivoWS.send(JSON.stringify(audioDelta));
          break;
        case 'response.function_call_arguments.done':
          if (response.name === 'calc_sum') {
            const output = itemForFunctionOutput(JSON.parse(response.arguments), response.item_id, response.call_id)
            realtimeWS.send(JSON.stringify(output))

            const generateResponse = {
              type: "response.create",
              response: {
                modalities: ["text", "audio"],
                temperature: 0.8,
                instructions: 'Please share the sum from the function call output with the user'
              }
            }

            realtimeWS.send(JSON.stringify(generateResponse))
          }
          break;
        default:
          console.log('Response received from the Realtime API is ', response.type)
      }
    } catch (error) {
      console.error('Error processing openAI message: ', error, 'Raw message: ', message)
    }
  });
  return realtimeWS
}

wss.on('connection', (connection) => {
  console.log('Client connected to WebSocket');

  // start the openAI realtime websocket connection
  const realtimeWS = startRealtimeWSConnection(connection);

  connection.on('message', (message) => {
    try {
      const data = JSON.parse(message)
      switch (data.event) {
        case 'media':
          if (realtimeWS && realtimeWS.readyState === WebSocket.OPEN) {
            const audioAppend = {
              type: 'input_audio_buffer.append',
              audio: data.media.payload
            }

            realtimeWS.send(JSON.stringify(audioAppend))
          }
          break;
        case 'start':
          console.log('Incoming stream has started')
          break;
        default:
          console.log('Received non-media evengt: ', data.event)
          break
      }
    } catch (error) {
      console.error('Error parsing message: ', error, 'Message: ', message)
    }
  });

  connection.on('close', () => {
    if (realtimeWS.readyState === WebSocket.OPEN) realtimeWS.close();
    console.log('client disconnected')
  });


});


server.listen(PORT, () => {
  // if (err) throw err
  console.log('server started on port 5000')
  client = new Client(process.env.PLIVO_AUTH_ID, process.env.PLIVO_AUTH_TOKEN)
  let response = client.calls.create(
    process.env.PLIVO_FROM_NUMBER,
    process.env.PLIVO_TO_NUMBER,
    process.env.PLIVO_ANSWER_XML,
    { answerMethod: "GET" })
    .then((call) => {
      console.log('call created ', call)
    }).catch((e) => {
      console.log('error is ', e)
    })
})