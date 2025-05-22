require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const http = require('http');
const { Server } = require('socket.io');
const { initializeApp } = require('firebase/app');
const { getDatabase, ref, set, get, push, update, remove, query, orderByChild, equalTo } = require('firebase/database');
const { Buffer } = require('buffer');
const fetch = require('node-fetch');
require('dotenv').config(); 

// 1. Configurações
const firebaseConfig = {
  apiKey: "AIzaSyBfjrD4DDMz2ucwLvdxf3-6K98514ZaSdw",
  authDomain: "app-project-farmatical.firebaseapp.com",
  databaseURL: "https://app-project-farmatical-default-rtdb.firebaseio.com",
  projectId: "app-project-farmatical",
  storageBucket: "app-project-farmatical.firebasestorage.app",
  messagingSenderId: "264403208467",
  appId: "1:264403208467:web:a7fb74ed3c6c7998eff2e6",
  measurementId: "G-XR9NWN60G6"
};

const Globalurl = "https://api.z-api.io";
const ClientToken = process.env.CLIENT_TOKEN;
const workHours = ["10:00", "10:30", "11:00", "11:30", "12:00", "12:30", "13:00", "13:30", "14:00", "14:30", "15:00", "15:30"];

const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REDIRECT_URI = 'http://localhost:3000/google';
const SCOPES = ['https://www.googleapis.com/auth/calendar'];

// 2. Inicialização
const firebaseApp = initializeApp(firebaseConfig);
const db = getDatabase(firebaseApp);
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*", // Ou seu domínio específico
    methods: ["GET", "POST"]
  }
});

const activeConnections = {};

const activeSessions = {};

// 3. Middlewares
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors({ origin: 'http://localhost:3000' }));

// 4. Função para enviar mensagens
async function sendMessageAll(body) {
  try {
    const response = await fetch(`${Globalurl}/instances/3E19757BC3D3C0A275782A6BCFBBBF38/token/1591F8E112B23AA7B12BB43E/send-text`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Client-Token': ClientToken,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) throw new Error(`Erro: ${response.statusText}`);
    return await response.json();
  } catch (error) {
    console.error('Erro ao enviar mensagem:', error);
    throw error;
  }
}

async function getAvailableEmployees(userId, date, time) {
  const userData = await get(ref(db, `${userId}`)).then(s => s.val());
  const appointments = Object.values(userData.agendamentos || {});
  
  return Object.entries(userData.funcionarios || {})
    .filter(([empKey, emp]) => {
      return !appointments.some(a => 
        a.date === date && 
        a.time === time && 
        a.employee === empKey
      );
    })
    .map(([key, emp]) => ({
      key,
      nome: emp.nome
    }));
}
// 5. Busca usuário pelo nome em Base64
async function findUserByNameBase64(nameBase64) {
  try {
    const usersRef = ref(db, '/');
    const snapshot = await get(query(usersRef, orderByChild('nameBase64'), equalTo(nameBase64)));
    
    if (snapshot.exists()) {
      const users = snapshot.val();
      return Object.keys(users)[0]; // Retorna o primeiro ID encontrado
    }
    return null;
  } catch (error) {
    console.error('Erro ao buscar usuário:', error);
    return null;
  }
}

async function getAvailableTimes(userId, date) {
  const userData = await get(ref(db, `${userId}`)).then(s => s.val());
  const appointments = Object.values(userData.agendamentos || {});
  const allEmployees = Object.keys(userData.funcionarios || {});
  
  return workHours.filter(time => {
    // Conta quantos funcionários estão ocupados neste horário
    const busyEmployees = appointments
      .filter(a => a.date === date && a.time === time)
      .map(a => a.employee);

      console.log('BusyEmployees::::', busyEmployees)
    
    // Horário só está disponível se pelo menos 1 funcionário estiver livre
    return busyEmployees.length < allEmployees.length;
  });
}


// 6. Processador de Mensagens
async function processMessage(phone, message) {
  // Verifica se é uma nova sessão
  if (!activeSessions[phone]) {
    // Verifica se é o código Base64 do estabelecimento
    if (!message.includes('.')) {
      const userId = await findUserByNameBase64(message.trim());
      
      if (!userId) {
        await sendMessageAll({
          phone: `+${phone}`,
          message: "❌ Estabelecimento não encontrado. Verifique o código."
        });
        return;
      }

      // Cria nova sessão no objeto
      activeSessions[phone] = {
        step: 'waiting_client_name',
        userId,
        userBase64: message.trim(), // Armazena o Base64 do estabelecimento
        clientName: null,
        selectedDate: null,
        selectedTime: null,
        selectedService: null,
        selectedEmployee: null
      };

      console.log('Sessões de agendamentos::::::',activeSessions)

      await sendMessageAll({
        phone: `+${phone}`,
        message: "🏢 Estabelecimento identificado! Digite seu nome completo:"
      });
      return;
    }
  }

  const session = activeSessions[phone];
  if (!session) return;

  // Fluxo principal
  switch (session.step) {
    case 'waiting_client_name':
      session.clientName = message;
      session.step = 'waiting_date';
      await sendMessageAll({
        phone: `+${phone}`,
        message: `👋 Olá ${message}! Informe a data desejada (DD/MM):`
      });
      break;

      case 'waiting_date':
        if (/^\d{2}\/\d{2}$/.test(message)) {
          const [day, month] = message.split('/').map(Number);
          const dateObj = new Date(new Date().getFullYear(), month - 1, day);
          
          if (dateObj.getDate() === day && dateObj.getMonth() + 1 === month) {
            const availableTimes = await getAvailableTimes(session.userId, message);
            
            if (availableTimes.length > 0) {
              await update(sessionRef, { 
                step: 'waiting_time', 
                selectedDate: message 
              });
              await sendMessageAll({
                phone: `+${phone}`,
                message: `⏰ Horários disponíveis para ${message}:\n${availableTimes.join('\n')}`
              });
            } else {
              await sendMessageAll({
                phone: `+${phone}`,
                message: "❌ Todos os horários estão ocupados nesta data. *Escolha outra data (DD/MM):*"
              });
            }
          }
        }
        break;

    case 'waiting_time':
      if (workHours.includes(message)) {
        session.selectedTime = message;
        session.step = 'waiting_service';

        const userData = await get(ref(db, `${session.userId}`)).then(s => s.val());
        const services = Object.values(userData.servicos || {})
          .map((s, i) => `${i+1}. ${s.nome} - R$ ${s.valor}`)
          .join('\n');

        await sendMessageAll({
          phone: `+${phone}`,
          message: `💇 Serviços disponíveis:\n${services}\n\n*Digite o número do serviço:*`
        });
      } else {
        await sendMessageAll({
          phone: `+${phone}`,
          message: "⚠️ Horário inválido. Escolha da lista:"
        });
      }
      break;

    case 'waiting_service':
      if (/^[1-9]$/.test(message)) {
        const userData = await get(ref(db, `${session.userId}`)).then(s => s.val());
        const serviceId = Object.keys(userData.servicos || {})[parseInt(message)-1];
        
        if (serviceId) {
          session.selectedService = userData.servicos[serviceId];
          session.step = 'waiting_employee';

          // Busca funcionários disponíveis
          const availableEmployees = await getAvailableEmployees(
            session.userId,
            session.selectedDate,
            session.selectedTime
          );

          if (availableEmployees.length > 0) {
            const employeesList = availableEmployees
              .map((emp, i) => `${i+1}. ${emp.nome}`)
              .join('\n');
            
            await sendMessageAll({
              phone: `+${phone}`,
              message: `👤 Profissionais disponíveis:\n${employeesList}\n\nDigite o número do profissional:`
            });
          } else {
            await sendMessageAll({
              phone: `+${phone}`,
              message: "❌ Nenhum profissional disponível. Escolha outro horário:"
            });
            session.step = 'waiting_time';
          }
        }
      } else {
        await sendMessageAll({
          phone: `+${phone}`,
          message: "⚠️ Serviço inválido. Digite o número:"
        });
      }
      break;

    case 'waiting_employee':
      if (/^[1-9]$/.test(message)) {
        const availableEmployees = await getAvailableEmployees(
          session.userId,
          session.selectedDate,
          session.selectedTime
        );

        const selectedEmp = availableEmployees[parseInt(message)-1];
        
        if (selectedEmp) {
          // Cria o agendamento
          const newAppointment = {
            date: session.selectedDate,
            time: session.selectedTime,
            employee: selectedEmp.key,
            employeeName: selectedEmp.nome,
            service: session.selectedService.nome,
            serviceValue: session.selectedService.valor,
            clientPhone: phone,
            clientName: session.clientName,
            establishment: session.userBase64, // Vincula ao Base64 do estabelecimento
            status: 'confirmed',
            createdAt: new Date().toISOString()
          };

          const dataVerifyToken = await verifyAndRefreshToken(session.userId)

          console.log('ACCESS TOKEN SUCESS',dataVerifyToken)
          await push(ref(db, `${session.userId}/agendamentos`), newAppointment);
          
          // Remove a sessão
          delete activeSessions[phone];

          // Confirmação final
          await sendMessageAll({
            phone: `+${phone}`,
            message: `✅ Agendamento confirmado com ${selectedEmp.nome}!\n📅 ${newAppointment.date} às ${newAppointment.time}\n💼 ${newAppointment.service}\n💰 R$ ${newAppointment.serviceValue}`
          });

          // Notifica via Socket.IO
          io.emit('new_appointment', { 
            userId: session.userId, 
            appointment: newAppointment 
          });
        } else {
          await sendMessageAll({
            phone: `+${phone}`,
            message: "⚠️ Profissional indisponível. Escolha outro:"
          });
        }
      }
      break;
  }
}


app.post('/auth/callback', async (req, res) => {
  const { code, userId } = req.body; // Recebe o 'code' (não access_token)

  try {
    // Troca o código por tokens
    const { data } = await axios.post('https://oauth2.googleapis.com/token', {
      code,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: REDIRECT_URI,
      grant_type: 'authorization_code',
    });

    const { 
      access_token, 
      expires_in, 
      refresh_token,
      token_type 
    } = data;

    // Calcula a data de expiração
    const expires_at = Date.now() + (expires_in * 1000);
    
    const tokens = {
      access_token,
      expires_at, // Armazenamos o timestamp de expiração
      refresh_token,
      token_type
    };

    // Salva no Firebase
    await set(ref(db, `${userId}/tokens`), tokens);

    res.status(200).json({ 
      success: true,
      access_token,
      expires_in 
    });

  } catch (error) {
    console.error('Erro no callback:', error.response?.data || error.message);
    res.status(500).json({ 
      error: 'Falha na autenticação',
      details: error.response?.data || error.message 
    });
  }
});

app.post('/auth/refresh', async (req, res) => {
  const { userId,access_token } = req.body;

  try {
    // Busca dados do usuário no Firebase
    const snapshot = await get(ref(db, userId));
    const userData = snapshot.val();


    const { data } = await axios.post('https://oauth2.googleapis.com/token', {
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      access_token:access_token,
      grant_type: 'refresh_token',
    });

console.log('DATA REFRESH:::',data)

  } catch (error) {
    console.error('Erro ao renovar token:', error);
    res.status(401).json({ error: 'Token expirado. Reautentique-se.' });
  }
});


async function verifyAndRefreshToken(userId, margin = 300) {
  if (!userId) throw new Error('ID do usuário é obrigatório');

  // 1. Buscar tokens no banco de dados
  const snapshot = await get(ref(db, `users/${userId}/tokens`));
  const tokens = snapshot.val();
  
  if (!tokens) throw new Error('Nenhum token encontrado para este usuário');
  if (!tokens.refresh_token) throw new Error('Refresh token não disponível');

  // 2. Verificar validade do access token
  const currentTime = Date.now();
  const isTokenValid = tokens.access_token_expiry 
    && (tokens.access_token_expiry - currentTime > margin * 1000);

  // 3. Se o token ainda é válido, retorná-lo
  if (isTokenValid) {
    return {
      access_token: tokens.access_token,
      expires_in: Math.floor((tokens.access_token_expiry - currentTime) / 1000),
      token_type: tokens.token_type || 'Bearer'
    };
  }

  // 4. Verificar validade do refresh token
  if (currentTime > tokens.refresh_token_expiry) {
    throw {
      message: 'Refresh token expirado. Reautentique-se.',
      requiresReauth: true
    };
  }

  // 5. Renovar o access token
  try {
    const { data } = await axios.post('https://oauth2.googleapis.com/token', {
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: tokens.refresh_token,
      grant_type: 'refresh_token',
    });

    // 6. Atualizar no banco de dados
    const newExpiry = currentTime + (data.expires_in * 1000);
    const updatedTokens = {
      ...tokens,
      access_token: data.access_token,
      access_token_expiry: newExpiry
    };

    await set(ref(db, `users/${userId}/tokens`), updatedTokens);

    return {
      access_token: data.access_token,
      expires_in: data.expires_in,
      token_type: data.token_type || 'Bearer'
    };

  } catch (error) {
    console.error('Erro ao renovar token:', error.response?.data || error.message);
    
    if (error.response?.status === 400) {
      throw {
        message: 'Refresh token inválido. Reautentique-se.',
        requiresReauth: true,
        details: error.response.data
      };
    }
    
    throw {
      message: 'Erro ao renovar token',
      details: error.response?.data || error.message
    };
  }
}

app.post('/webhook', async (req, res) => {
  const  phone = req.body.phone;

  const message = req.body.text.message

  console.log('Telefone Contato', phone)

  console.log('Mensagem Contato',phone)
  
  try {
    await processMessage(phone, message);
    res.status(200).json({ success: true });
  } catch (error) {
    console.error("Erro:", error);
    res.status(500).json({ error: "Erro interno" });
  }
});

async function configureWebhook() {
  try {
    const response = await axios.put(
      "https://api.z-api.io/instances/3E19757BC3D3C0A275782A6BCFBBBF38/token/1591F8E112B23AA7B12BB43E/update-webhook-received",
      { value: "https://backproject.vercel.app/webhook" },
      { headers: { 'Client-Token':'Fbd62247981a742ec897582f51b86779aS' } }
    );
    console.log('✅ Webhook configurado com sucesso:', response.data);
  } catch (error) {
    console.error('❌ Erro ao configurar webhook:', error.response?.data || error.message);
  }
}

// 8. Inicialização
const PORT = process.env.PORT || 3030;
server.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
  console.log(`📌 Estrutura Firebase: {userId}/agendamentos`);
  console.log('Sessões',activeSessions);
  configureWebhook();
});