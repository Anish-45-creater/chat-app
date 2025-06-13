const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: 'http://localhost:3000',
    methods: ['GET', 'POST'],
  },
});

const rooms = {
  public: { users: {}, messages: [] }, // Default public room
};

const socketToUserMap = {};

const validateUsername = (username) => {
  // Check minimum length
  if (username.length < 5) {
    return 'Username must be at least 5 characters long.';
  }

  // Check for at least 2 numbers
  const numberCount = (username.match(/\d/g) || []).length;
  if (numberCount < 2) {
    return 'Username must contain at least 2 numbers.';
  }

  // Check for at least 1 special character
  const specialCharRegex = /[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>?`~]/;
  if (!specialCharRegex.test(username)) {
    return 'Username must contain at least 1 special character (e.g., !@#$%).';
  }

  return null; // Validation passed
};

io.on('connection', (socket) => {
  console.log('A user connected:', socket.id);

  socket.on('check_room', (roomId, callback) => {
    const room = roomId || 'public';
    const roomExists = rooms[room] && Object.keys(rooms[room].users).length > 0;
    console.log(`Checking room ${room}: exists and live = ${roomExists}`);
    callback(roomExists);
  });

  socket.on('join_room', ({ username, roomId }) => {
    const room = roomId || 'public';
    // Standardize username: trim and lowercase
    const standardizedUsername = username.trim().toLowerCase();

    // Validate username format
    const validationError = validateUsername(standardizedUsername);
    if (validationError) {
      console.log(`Invalid username format: ${standardizedUsername} - ${validationError}`);
      socket.emit('join_error', validationError);
      return;
    }

    // Check if the username is already taken in the room
    if (rooms[room] && rooms[room].users[standardizedUsername]) {
      console.log(`Username ${standardizedUsername} is already taken in room ${room}`);
      socket.emit('join_error', 'Username already taken in this room.');
      return;
    }

    socket.join(room);

    if (!rooms[room]) {
      rooms[room] = { users: {}, messages: [] };
    }

    rooms[room].users[standardizedUsername] = { socketId: socket.id, username: standardizedUsername };
    socketToUserMap[socket.id] = { username: standardizedUsername, room };
    console.log(`User ${standardizedUsername} joined room ${room} with socket ID: ${socket.id}`);
    console.log(`Current users in room ${room}:`, rooms[room].users);

    // Send chat history to the joining user
    console.log(`Sending chat history for room ${room}:`, rooms[room].messages);
    socket.emit('chat_history', rooms[room].messages);

    // Update user list for all users in the room
    io.to(room).emit('user_list', Object.values(rooms[room].users));

    // Broadcast join message to all users in the room
    const joinMessage = `${username} joined the chat`;
    const messageId = `system-${Date.now()}-${socket.id}`;
    const systemMessageData = { message: joinMessage, time: new Date().toLocaleTimeString(), messageId, type: 'system' };
    rooms[room].messages.push(systemMessageData);
    io.to(room).emit('system_message', systemMessageData);

    // Confirm join success to the client
    console.log(`Emitting join_success to socket ${socket.id}`);
    socket.emit('join_success');
  });

  socket.on('send_message', ({ messageData, roomId }) => {
    const room = roomId || 'public';
    console.log(`Received message in room ${room}:`, messageData);
    if (messageData && messageData.username && messageData.message && messageData.time) {
      const messageId = Date.now() + '-' + socket.id;
      const fullMessageData = { ...messageData, userId: socket.id, messageId };
      rooms[room].messages.push(fullMessageData);
      console.log(`Stored message in room ${room}:`, fullMessageData);
      console.log(`Current message history in room ${room}:`, rooms[room].messages);
      console.log(`Broadcasting message to room ${room}:`, fullMessageData);
      io.to(room).emit('receive_message', fullMessageData);
    } else {
      console.log('Invalid message data:', messageData);
    }
  });

  socket.on('typing', ({ roomId }) => {
    const room = roomId || 'public';
    const userInfo = socketToUserMap[socket.id];
    if (userInfo && rooms[room]) {
      socket.to(room).emit('user_typing', { socketId: socket.id, username: userInfo.username });
    }
  });

  socket.on('leave_room', ({ roomId }) => {
    const room = roomId || 'public';
    const userInfo = socketToUserMap[socket.id];
    if (userInfo && rooms[room] && rooms[room].users[userInfo.username]) {
      console.log(`User ${userInfo.username} leaving room ${room}:`, socket.id);

      // Broadcast leave message to all users in the room
      const leaveMessage = `${userInfo.username} left the chat`;
      const messageId = `system-${Date.now()}-${socket.id}`;
      const systemMessageData = { message: leaveMessage, time: new Date().toLocaleTimeString(), messageId, type: 'system' };
      rooms[room].messages.push(systemMessageData);
      io.to(room).emit('system_message', systemMessageData);

      delete rooms[room].users[userInfo.username];
      delete socketToUserMap[socket.id];
      socket.leave(room);
      io.to(room).emit('user_list', Object.values(rooms[room].users));
      // Clean up the room if it's empty (except for public room)
      if (room !== 'public' && rooms[room] && Object.keys(rooms[room].users).length === 0) {
        console.log(`Room ${room} is empty, removing it.`);
        delete rooms[room];
      }
    }
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    const userInfo = socketToUserMap[socket.id];
    if (userInfo) {
      const room = userInfo.room;
      if (rooms[room] && rooms[room].users[userInfo.username]) {
        // Broadcast leave message to remaining users in the room
        const leaveMessage = `${userInfo.username} left the chat`;
        const messageId = `system-${Date.now()}-${socket.id}`;
        const systemMessageData = { message: leaveMessage, time: new Date().toLocaleTimeString(), messageId, type: 'system' };
        rooms[room].messages.push(systemMessageData);
        socket.to(room).emit('system_message', systemMessageData);

        delete rooms[room].users[userInfo.username];
        io.to(room).emit('user_list', Object.values(rooms[room].users));
        // Clean up the room if it's empty (except for public room)
        if (room !== 'public' && rooms[room] && Object.keys(rooms[room].users).length === 0) {
          console.log(`Room ${room} is empty, removing it.`);
          delete rooms[room];
        }
      }
      delete socketToUserMap[socket.id];
    }
  });
});

app.get('/', (req, res) => {
  res.send('Chat server is running');
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));