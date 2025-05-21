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
const REDIRECT_URI = 'http://localhost:3000/auth/callback';
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
    const response = await fetch(`${Globalurl}/instances/3E019F6A2AD3400FBE778E66062CE0C1/token/0F4CC44688C0009373197BB4/send-text`, {
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

          // Salva no Firebase
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

app.get('/auth/google', (req, res) => {
  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.searchParams.set('client_id', CLIENT_ID);
  authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', SCOPES.join(' '));
  authUrl.searchParams.set('access_type', 'offline');
  authUrl.searchParams.set('prompt', 'consent');

  res.redirect(authUrl.toString());
});

app.get('/auth/callback', async (req, res) => {
  const { code } = req.query;

  try {
    // Troca o código por tokens
    const { data } = await axios.post('https://oauth2.googleapis.com/token', {
      code,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: REDIRECT_URI,
      grant_type: 'authorization_code',
    });

    const { access_token, refresh_token } = data;


          const tokens = {
             userId:userId,
             access_token,
             refresh_token
          };

          // Salva no Firebase
          await set(ref(db, `${userId}/tokens`), tokens);

  } catch (error) {
    console.error('Erro no callback:', error.response.data);
    res.status(500).send('Falha na autenticação');
  }
});

app.post('/auth/refresh', async (req, res) => {
  const { userId } = req.body;

  try {
    // Busca dados do usuário no Firebase
    const snapshot = await get(ref(db, userId));
    const userData = snapshot.val();

    if (!userData?.refresh_token) {
      return res.status(401).json({ error: 'Usuário não autenticado' });
    }

    const { data } = await axios.post('https://oauth2.googleapis.com/token', {
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: userData.refresh_token,
      grant_type: 'refresh_token',
    });

    // Atualiza o token no Firebase
    await set(ref(db, 'users/' + userId + '/access_token'), data.access_token);
    await set(ref(db, 'users/' + userId + '/expires_in'), data.expires_in);

    res.json({ access_token: data.access_token });

  } catch (error) {
    console.error('Erro ao renovar token:', error.response.data);
    res.status(401).json({ error: 'Token expirado. Reautentique-se.' });
  }
});

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
      "https://api.z-api.io/instances/3E019F6A2AD3400FBE778E66062CE0C1/token/0F4CC44688C0009373197BB4/update-webhook-received",
      { value: "https://backproject.vercel.app/weebhook" },
      { headers: { 'Client-Token': 'F47c6b24b03ef4ecb84a2a76b0fc8617eS' } }
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