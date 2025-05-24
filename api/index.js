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
        'Client-Token': 'Fbd62247981a742ec897582f51b86779aS',
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

async function createGoogleCalendarEvent(calendarId, bearerToken, eventData) {
  const url = `https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events`;

  try {
    const response = await axios.post(url, eventData, {
      headers: {
        'Authorization': `Bearer ${bearerToken}`,
        'Content-Type': 'application/json',
      },
    });

    return response.data;
  } catch (error) {
    console.error('Erro ao criar evento:', error.response?.data || error.message);
    throw new Error(error.response?.data?.error?.message || 'Falha ao criar evento');
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

function formatDateTime(dateYYYYMMDD, timeHHMM, durationMinutes = 30) {
  try {
    // Verifica se os parâmetros estão no formato correto
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateYYYYMMDD) || !/^\d{2}:\d{2}$/.test(timeHHMM)) {
      throw new Error('Formato inválido. Use YYYY-MM-DD para data e HH:MM para hora');
    }

    // Extrai ano, mês, dia
    const [year, month, day] = dateYYYYMMDD.split('-').map(Number);
    const [hours, minutes] = timeHHMM.split(':').map(Number);

    // Valida os valores
    if (month < 1 || month > 12 || day < 1 || day > 31) {
      throw new Error('Data inválida');
    }

    // Cria a data com validação
    const startDateTime = new Date(year, month - 1, day, hours, minutes);

    // Verifica se a data criada é válida
    if (isNaN(startDateTime.getTime())) {
      throw new Error('Data/hora inválida');
    }

    // Calcula a data de término
    const endDateTime = new Date(startDateTime.getTime() + durationMinutes * 60000);

    // Formata para ISO 8601 (UTC)
    const formatISO = (date) => {
      const pad = (num) => num.toString().padStart(2, '0');
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T` +
        `${pad(date.getHours())}:${pad(date.getMinutes())}:00`;
    };

    return {
      start: formatISO(startDateTime),
      end: formatISO(endDateTime),
      timeZone: 'America/Sao_Paulo' // Opcional
    };

  } catch (error) {
    console.error('Erro em formatDateTime:', error.message);
    throw new Error('Falha ao formatar data. Verifique os valores e formatos (YYYY-MM-DD para data e HH:MM para hora)');
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

async function findUserByInstance(instanceId) {
  try {
    const usersRef = ref(db, '/');
    const snapshot = await get(usersRef);

    if (!snapshot.exists()) {
      console.log("Nenhum usuário encontrado");
      return null;
    }

    // Correção: acessar userData.tokenZAPI corretamente
    const userEntry = Object.entries(snapshot.val()).find(
      ([userId, userData]) =>
        userData.tokenZAPI &&
        userData.tokenZAPI.instance === instanceId
    );

    if (userEntry) {
      const [userId, userData] = userEntry;
      return {
        userId,
        ...userData.tokenZAPI
      };
    }

    console.log("Instância não encontrada");
    return null;

  } catch (error) {
    console.error("Erro ao buscar usuário:", error);
    throw error;
  }
}


// 6. Processador de Mensagens
async function processMessage(phone, message, instanceId) {

  const userRef = ref(db, '/');
  const snapshot = await get(userRef) || []


  const findByInstance = await findUserByInstance(instanceId)

  const preId = findByInstance.userEmail;
  const userId = Buffer.from(preId).toString('base64');



  if (!activeSessions[phone]) {
    // Inicia diretamente com a escolha inicial
    activeSessions[phone] = {
      step: 'waiting_initial_choice',
      currentQuestionIndex: 0,
      questions: [],
      userId: userId,
      clientName: null,
      selectedDate: null,
      selectedTime: null,
      selectedService: null,
      selectedEmployee: null
    };

    await sendMessageAll({
      phone: `+${phone}`,
      message: "👋 *Bem-vindo!* Escolha uma opção:\n\n1. Iniciar agendamento\n2. Conhecer serviços e valores"
    });
    return;
  }

  const session = activeSessions[phone];
  if (!session) return;



  /*
  if (session.step === 'answering_questions') {
    await sendMessage(phone, activeSessions[phone].questions[0].question);
    const currentQ = session.questions[session.currentQuestionIndex];
  
    // Armazena a resposta
    currentQ.answer = message;
    console.log(`Resposta registrada: ${currentQ.question} - ${currentQ.answer}`);
  
    // Verifica se há mais perguntas
    if (session.currentQuestionIndex < session.questions.length - 1) {
      session.currentQuestionIndex++;
      await sendMessage(phone, session.questions[session.currentQuestionIndex].question);
    } else {
      // Todas perguntas respondidas, inicia agendamento
      session.step = 'waiting_client_name';
      await sendMessage(phone, "Obrigado pelas respostas! Agora *digite seu nome* para agendar:");
  
      // Opcional: enviar resumo das respostas
      const summary = session.questions.map(q => `• ${q.question}: ${q.answer}`).join('\n');
      await sendMessage(phone, `📝 Suas respostas:\n${summary}`);
    }
    return;
  } else {
    // Todas perguntas respondidas, inicia agendamento
    session.step = 'waiting_date';
  
    await sendMessage(phone, `📝 Suas respostas:\n${summary}`);
  
    await sendMessage(phone, "Obrigado pelas respostas! Informe a data desejada (DD/MM):\n *Ex.: 18/05*");
  
    const summary = session.questions.map(q => `• ${q.question}: ${q.answer}`).join('\n');
  
  }*/

  // Fluxo principal
  switch (session.step) {

    case 'waiting_initial_choice':
      if (message === '1') {
        // Busca perguntas do banco de dados
        session.questions = await get(ref(db, `${session.userId}/mensagens`))
          .then(s => s.val() || [])
          .catch(() => []);

        if (session.questions.length > 0) {
          session.step = 'answering_questions';
          await sendMessage(phone, session.questions[0].question);
        } else {
          session.step = 'waiting_client_name';
          await sendMessageAll({
            phone: `+${phone}`,
            message: "Por favor, digite seu *nome completo* para continuar:"
          });
        }
      } else if (message === '2') {
        const userData = await get(ref(db, `${session.userId}`)).then(s => s.val());
        const services = Object.entries(userData.servicos)
          .map((s, i) =>
            `*${i + 1}. ${s.nome}* - R$ ${s.valor}\n` +
            `${s.descricao || 'Sem descrição disponível'}\n` +
            `──────────────────`
          )
          .join('\n');

        await sendMessageAll({
          phone: `+${phone}`,
          message: `💎 *SERVIÇOS DISPONÍVEIS* 💎\n\n${services}\n\n*Digite 1 para iniciar agendamento*`
        });
      } else {
        await sendMessageAll({
          phone: `+${phone}`,
          message: "⚠️ Opção inválida. Por favor, *digite*\n\n1️⃣ Para *Iniciar Agendamento*\n2️⃣ Para *Ver Serviços*"
        });
      }
      break;

    case 'answering_questions':
      const currentQ = session.questions[session.currentQuestionIndex];
      currentQ.answer = message;

      if (session.currentQuestionIndex < session.questions.length - 1) {
        session.currentQuestionIndex++;
        await sendMessage(phone, session.questions[session.currentQuestionIndex].question);
      } else {
        session.step = 'waiting_client_name';
        const summary = session.questions.map(q => `• ${q.question}: ${q.answer}`).join('\n');
        await sendMessageAll({
          phone: `+${phone}`,
          message: `📋 *Resumo das Respostas*\n${summary}\n\nPor favor, digite seu *nome completo* para continuar:`
        });
      }
      break;

    case 'waiting_client_name':
      session.clientName = message;
      session.step = 'waiting_date';
      await sendMessageAll({
        phone: `+${phone}`,
        message: `👋 *Olá ${message}!* Informe a data desejada (DD/MM):\n*Exemplo: 25/12*`
      });
      break;


    case 'waiting_date':
      // Verifica formato DD/MM
      if (!/^\d{2}\/\d{2}$/.test(message)) {
        await sendMessageAll({
          phone: `+${phone}`,
          message: "⚠️ Formato inválido. Por favor, digite a data no formato *DD/MM* (ex: 25/12)"
        });
        return;
      }

      const [day, month] = message.split('/').map(Number);
      const currentYear = new Date().getFullYear();
      const dateObj = new Date(currentYear, month - 1, day);

      // Validação da data
      const isInvalidDate = (
        dateObj.getDate() !== day ||
        dateObj.getMonth() + 1 !== month ||
        dateObj < new Date() // Não permite datas passadas
      );

      if (isInvalidDate) {
        await sendMessageAll({
          phone: `+${phone}`,
          message: "❌ Data inválida ou já passou. Digite uma data válida (DD/MM):"
        });
        return;
      }

      // Formata data para YYYY-MM-DD para consulta
      const formattedDate = `${currentYear}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`;

      try {
        const availableTimes = await getAvailableTimes(session.userId, formattedDate);

        if (availableTimes.length === 0) {
          await sendMessageAll({
            phone: `+${phone}`,
            message: "❌ Todos os horários estão ocupados nesta data. *Escolha outra data (DD/MM):*"
          });
          return;
        }

        // Atualiza sessão
        session.selectedDate = formattedDate;
        session.step = 'waiting_time';

        await sendMessageAll({
          phone: `+${phone}`,
          message: `⏰ *Horários disponíveis para ${message}:*\n${availableTimes.map(t => `• ${t}`).join('\n')}\n\n*Digite o horário desejado: *Exemplo: 10:00**`
        });

      } catch (error) {
        console.error("Erro ao buscar horários:", error);
        await sendMessageAll({
          phone: `+${phone}`,
          message: "⚠️ Erro ao verificar disponibilidade. Tente novamente com outra data:"
        });
      }
      break;
    case 'waiting_time':
      if (workHours.includes(message)) {
        session.selectedTime = message;
        session.step = 'waiting_service';


        const userData = await get(ref(db, `${session.userId}`)).then(s => s.val());
        const services = Object.values(userData.servicos || {})
          .map((s, i) => `${i + 1}. ${s.nome} - R$ ${s.valor}`)
          .join('\n');

        await sendMessageAll({
          phone: `+${phone}`,
          message: `💇 Serviços disponíveis:\n${services}\n\n*Digite o número do serviço:*`
        });
      } else {
        const availableTimes = await getAvailableTimes(session.userId, session.selectedDate);
        await sendMessageAll({
          phone: `+${phone}`,
          message: `⚠️ Horário inválido. Escolha da lista: no formato: >> *10:00*\n\n${availableTimes}`
        });
        session.step = 'waiting_service'
      }
      break;

    case 'waiting_service':
      if (/^[1-9]$/.test(message)) {
        const userData = await get(ref(db, `${session.userId}`)).then(s => s.val());
        const serviceId = Object.keys(userData.servicos || {})[parseInt(message) - 1];

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
              .map((emp, i) => `${i + 1}. ${emp.nome}`)
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

        const selectedEmp = availableEmployees[parseInt(message) - 1];

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
            establishment: session.userId, // Vincula ao Base64 do estabelecimento
            status: 'confirmed',
            createdAt: new Date().toISOString()
          };
          const { start, end } = formatDateTime(newAppointment.date, newAppointment.time, 30);
          const eventData = {

            "end": {
              "dateTime": `${end}`,
              "timeZone": "America/Sao_Paulo",
            },
            "start": {
              "dateTime": `${start}`,
              "timeZone": "America/Sao_Paulo",
            },
          };

          const userIdCalendar = await get(ref(db, `${session.userId}/googleAgenda`))

          const snapShotIdcalendar = userIdCalendar.val();

          if (snapShotIdcalendar) {
            const dataVerifyToken = await verifyAndRefreshToken(session.userId)

            if (dataVerifyToken?.access_token) {
              const calendarEvent = await createGoogleCalendarEvent(snapShotIdcalendar.idAgenda, dataVerifyToken.access_token, eventData)
              console.log('AGENDAMENTO NO GOOGLE AGENDA FEITO COM SUCESSO::::', calendarEvent)
            }

          console.log('ACCESS TOKEN SUCESS', dataVerifyToken)

          }



          await push(ref(db, `${session.userId}/agendamentos`), newAppointment);

          // Remove a sessão
          delete activeSessions[phone];

          // Confirmação final
          await sendMessageAll({
            phone: `+${phone}`,
            message: `✅ Agendamento confirmado com ${selectedEmp.nome}!\n📅 ${newAppointment.date} às ${newAppointment.time}\n💼 ${newAppointment.service}\n💰 R$ ${newAppointment.serviceValue}`
          });

          await sendMessageAll({
            phone: `+${phone}`,
            message: `Para *Agendar Novamente* nesse local use o código nos envie o código a abaixo`
          });

          await sendMessageAll({
            phone: `+${phone}`,
            message: `${userId}`
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
  const { code, userId } = req.body;

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
      token_type,
      refresh_token_expires_in
    } = data;

    // Calcula a data de expiração
    const expires_at = Date.now() + (expires_in * 1000);

    const tokens = {
      access_token,
      expires_at, // Armazenamos o timestamp de expiração
      refresh_token,
      token_type,
      refresh_token_expires_in
    };

    console.log(data)

    if (tokens.refresh_token && tokens.refresh_token_expires_in) {
      await set(ref(db, `${userId}/tokens`), tokens);
    }

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

async function verifyAndRefreshToken(userId, margin = 300) {
  if (!userId) throw new Error('ID do usuário é obrigatório');

  // 1. Buscar tokens no banco de dados
  const snapshot = await get(ref(db, `${userId}/tokens`));
  const tokens = snapshot.val();

  if (!tokens) throw new Error('Nenhum token encontrado para este usuário');
  if (!tokens.refresh_token) throw new Error('Refresh token não disponível');

  // 2. Verificar validade do access token
  const currentTime = Date.now() * 1000;
  const isTokenValid = tokens.expires_at
    && (tokens.expires_at - currentTime > margin * 1000);

  // 3. Se o token ainda é válido, retorná-lo
  if (isTokenValid) {
    return {
      access_token: tokens.access_token,
      expires_in: Math.floor((tokens.expires_at - currentTime) / 1000),
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
      expires_at: newExpiry
    };

    await set(ref(db, `${userId}/tokens`), updatedTokens);

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


app.post('/auth/refresh', async (req, res) => {
  const { userId } = req.body;
  const margin = req.body.margin || 300; // Margem padrão de 5 minutos

  try {
    // 1. Buscar tokens no banco de dados
    const snapshot = await get(ref(db, `${userId}/tokens`));
    const tokens = snapshot.val();

    if (!tokens) {
      return res.status(404).json({
        error: 'Nenhum token encontrado para este usuário',
        requiresReauth: true
      });
    }

    if (!tokens.refresh_token) {
      return res.status(400).json({
        error: 'Refresh token não disponível',
        requiresReauth: true
      });
    }

    // 2. Verificar validade do access token
    const currentTime = Date.now();
    const isTokenValid = tokens.expires_at &&
      (tokens.expires_at - currentTime > margin * 1000);

    // 3. Se o token ainda é válido, retorná-lo
    if (isTokenValid) {
      return res.status(200).json({
        success: true,
        access_token: tokens.access_token,
        expires_in: Math.floor((tokens.expires_at - currentTime) / 1000),
        token_type: tokens.token_type || 'Bearer'
      });
    }

    // 4. Verificar validade do refresh token (se existir a informação)
    if (tokens.refresh_token_expires_in &&
      currentTime > (tokens.expires_at + tokens.refresh_token_expires_in * 1000)) {
      return res.status(401).json({
        error: 'Refresh token expirado. Reautentique-se.',
        requiresReauth: true
      });
    }

    if (tokens.refresh_token) {
      const { data } = await axios.post('https://oauth2.googleapis.com/token', {
        client_id: process.env.CLIENT_ID,
        client_secret: process.env.CLIENT_SECRET,
        refresh_token: tokens.refresh_token,
        grant_type: 'refresh_token',
      });

    }

    // 6. Atualizar no banco de dados
    const newExpiry = Date.now() + (data.expires_in * 1000);
    const updatedTokens = {
      ...tokens,
      access_token: data.access_token,
      expires_at: newExpiry
    };

    await set(ref(db, `${userId}/tokens`), updatedTokens);

    // 7. Retornar novo token
    res.status(200).json({
      success: true,
      access_token: data.access_token,
      expires_in: data.expires_in,
      token_type: data.token_type || 'Bearer'
    });

  } catch (error) {
    console.error('Erro ao renovar token:', error.response?.data || error.message);

    if (error.response?.status === 400) {
      return res.status(401).json({
        error: 'Refresh token inválido. Reautentique-se.',
        requiresReauth: true,
        details: error.response.data
      });
    }

    res.status(500).json({
      error: 'Erro ao renovar token',
      details: error.response?.data || error.message
    });
  }
});
app.post('/webhook', async (req, res) => {
  const phone = req.body.phone;

  const message = req.body.text.message

  const instanceId = req.body.instanceId

  console.log('Telefone Contato', phone)

  console.log('Mensagem Contato', message)


  console.log('Instance ID', instanceId)

  try {
    await processMessage(phone, message, instanceId);
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
      {
        value: "https://backproject.vercel.app/webhook",
        enabled: true, // Adicione esta linha para garantir ativação
        events: ["MESSAGE_RECEIVED"] // Especificar eventos desejados
      },
      {
        headers: {
          'Client-Token': 'Fbd62247981a742ec897582f51b86779aS',
          'Content-Type': 'application/json' // Adicione este header
        }
      }
    );
    console.log('✅ Webhook configurado:', response.data);
    return response.data;
  } catch (error) {
    console.error('❌ Erro na configuração:', {
      status: error.response?.status,
      data: error.response?.data,
      message: error.message
    });
    throw error;
  }
}


// 8. Inicialização
const PORT = process.env.PORT || 3030;
server.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
  console.log(`📌 Estrutura Firebase: {userId}/agendamentos`);
  console.log('Sessões', activeSessions);
  configureWebhook();
});