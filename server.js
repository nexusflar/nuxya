require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// --- AUTHENTICATION ENDPOINTS (SECURE PASSWORDS) ---

app.post('/api/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Missing fields' });

  try {
    const salt = await bcrypt.genSalt(10);
    const password_hash = await bcrypt.hash(password, salt);

    const { data, error } = await supabase
      .from('users')
      .insert([{ username, password_hash }])
      .select()
      .single();

    if (error) return res.status(400).json({ error: 'Username taken or database error' });

    delete data.password_hash;
    res.json({ user: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  const { data: user, error } = await supabase
    .from('users')
    .select('*')
    .eq('username', username)
    .single();

  if (error || !user) return res.status(400).json({ error: 'Invalid credentials' });

  const isMatch = await bcrypt.compare(password, user.password_hash);
  if (!isMatch) return res.status(400).json({ error: 'Invalid credentials' });

  delete user.password_hash;
  res.json({ user });
});

// --- GROUP MANAGEMENT ENDPOINTS (MAX 15 MEMBERS) ---

app.post('/api/groups/create', async (req, res) => {
  const { name, userId, memberUsernames } = req.body; // Array of usernames

  if (memberUsernames.length > 14) {
    return res.status(400).json({ error: 'Group cannot exceed 15 members (including creator).' });
  }

  // Get user IDs for all invited usernames
  const { data: invitees } = await supabase
    .from('users')
    .select('id, username')
    .in('username', memberUsernames);

  const { data: group, error } = await supabase
    .from('groups')
    .insert([{ name, created_by: userId }])
    .select()
    .single();

  if (error) return res.status(400).json({ error: error.message });

  const membersToInsert = [{ group_id: group.id, user_id: userId }];
  if (invitees) {
    invitees.forEach(u => membersToInsert.push({ group_id: group.id, user_id: u.id }));
  }

  await supabase.from('group_members').insert(membersToInsert);

  res.json({ group });
});

// --- REAL-TIME WEBSOCKET (SOCKET.IO) & WEBRTC CALLING ---

const activeSockets = {}; // userId -> socketId

io.on('connection', (socket) => {
  socket.on('user_connected', (userId) => {
    activeSockets[userId] = socket.id;
    socket.userId = userId;
  });

  socket.on('join_group', (groupId) => {
    socket.join(groupId);
  });

  socket.on('send_message', async (data) => {
    // data: { groupId, senderId, content, mediaUrl }
    const { data: savedMsg } = await supabase
      .from('messages')
      .insert([{ group_id: data.groupId, sender_id: data.senderId, content: data.content, media_url: data.mediaUrl }])
      .select('*, users(username, avatar_url)')
      .single();

    io.to(data.groupId).emit('new_message', savedMsg);
  });

  socket.on('add_reaction', async ({ messageId, emoji, userId, groupId }) => {
    await supabase.from('reactions').upsert([{ message_id: messageId, user_id: userId, emoji }]);
    io.to(groupId).emit('reaction_updated', { messageId, emoji, userId });
  });

  // --- WEBRTC SIGNALING FOR CALLS & SCREEN SHARE ---
  socket.on('call_user', ({ userToCall, signalData, from, isScreenShare }) => {
    const targetSocket = activeSockets[userToCall];
    if (targetSocket) {
      io.to(targetSocket).emit('incoming_call', { signal: signalData, from, isScreenShare });
    }
  });

  socket.on('answer_call', ({ to, signal }) => {
    const targetSocket = activeSockets[to];
    if (targetSocket) {
      io.to(targetSocket).emit('call_accepted', signal);
    }
  });

  socket.on('disconnect', () => {
    if (socket.userId) delete activeSockets[socket.userId];
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));