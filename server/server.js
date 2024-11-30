const WebSocket = require('ws');
const wss = new WebSocket.Server({ port: 8080 });

console.log('WebSocket server started on ws://localhost:8080');


wss.on('connection', (socket) => {
  console.log('New client connected');

  socket.on('message', (rawMessage) => {
    try {
      // Convert Buffer to string if needed
      const message = typeof rawMessage === 'string' 
        ? rawMessage 
        : rawMessage.toString();
      
      const parsedMessage = JSON.parse(message);
      
      // More specific routing based on message type
      switch(parsedMessage.type) {
        case 'offer':
        case 'answer':
        case 'candidate':
          // Broadcast to all other clients except sender
          wss.clients.forEach((client) => {
            if (client !== socket && client.readyState === WebSocket.OPEN) {
              client.send(JSON.stringify(parsedMessage));
            }
          });
          break;
        default:
          console.warn('Unhandled message type:', parsedMessage.type);
      }
    } catch (error) {
      console.error('Error processing message:', error);
    }
  });

  socket.on('close', () => {
    console.log('Client disconnected');
  });
});