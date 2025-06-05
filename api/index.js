require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const http = require('http');
const { Server } = require('socket.io');
const { initializeApp } = require('firebase/app');
const { getDatabase, ref, set, get, push, update, remove, query, orderByChild, equalTo } = require('firebase/database');
const { Buffer } = require('buffer');
const { v4: uuidv4 } = require('uuid');
const fetch = require('node-fetch');
const base64 = require('base-64');
const path = require('path');
const fs = require('fs')
const multer = require('multer');
const { Storage } = require('@google-cloud/storage');
const { VertexAI } = require('@google-cloud/vertexai');
const { google } = require('googleapis');

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

const PROJECT_ID = 'schedulezap';
const LOCATION = "us-central1";
const GCS_BUCKET_NAME = 'bucket_videogen';

const Globalurl = "https://api.z-api.io";
const ClientToken = process.env.CLIENT_TOKEN;
const workHours = ["10:00", "10:30", "11:00", "11:30", "12:00", "12:30", "13:00", "13:30", "14:00", "14:30", "15:00", "15:30"];

const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REDIRECT_URI = 'http://localhost:3000/gerar';
const SCOPES = ['https://www.googleapis.com/auth/devstorage.full_control'];

const keyFilePath = path.join(__dirname, '..', 'schedulezap-d8554ab0fae1.json');


const vertex_ai = new VertexAI({ project: PROJECT_ID, location: LOCATION });
const storage = new Storage({ projectId: PROJECT_ID});


const bucketName = 'bucket_videogen';

const videoModel = 'veo-2.0-generate-001';

// Configuração do Multer para upload de arquivos temporários
const upload = multer({ dest: 'uploads/' }); // Salva arquivos temporariamente na pasta 'uploads'


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
async function sendMessageAll({ phone, instance, token, message }) {

  const bodyT = {
    phone,
    message
  }
  try {
    const response = await fetch(`${Globalurl}/instances/${instance}/token/${token}/send-text`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Client-Token': 'F6f5e779a04f5435cbe443d6fdea0699cS',
      },
      body: JSON.stringify(bodyT),
    });

    if (!response.ok) throw new Error(`Erro: ${response.statusText}`);
    return await response.json();
  } catch (error) {
    console.error('Erro ao enviar mensagem:', error);
    throw error;
  }
}

async function uploadImageToGCS(localFilePath, destinationFileName) {
  console.log(`Fazendo upload da imagem ${localFilePath} para gs://${GCS_BUCKET_NAME}/${destinationFileName}...`);
  try {
    await storage.bucket(GCS_BUCKET_NAME).upload(localFilePath, {
      destination: destinationFileName,
    });
    const gcsUri = `gs://${GCS_BUCKET_NAME}/${destinationFileName}`;
    console.log(`Upload concluído! URI do GCS: ${gcsUri}`);
    return gcsUri;
  } catch (error) {
    console.error('Erro ao fazer upload da imagem para o GCS:', error);
    throw error;
  }
}


async function generateVideoFromImage({ imageGcsUri, mimeType, aspectRatio, outputFileName, durationSeconds = 8, personGeneration = 'allow_adult' }) {
  const generativeModel = vertex_ai.preview.getGenerativeModel({ model: videoModel });
  const outputGcsUri = `gs://${GCS_BUCKET_NAME}/${outputFileName}`;

  console.log(`Gerando vídeo a partir da imagem GCS: "${imageGcsUri}"...`);

  const generateRequest = {
    model: videoModel,
    generateVideoRequest: {
      image: {
        gcsUri: imageGcsUri,
        mimeType: mimeType,
      },
      videoGenerationConfig: {
        aspectRatio: aspectRatio,
        outputGcsUri: outputGcsUri,
        numberOfVideos: 1,
        durationSeconds: durationSeconds,
        personGeneration: personGeneration,
      },
    },
  };

  const [operation] = await generativeModel.generateContentStream(generateRequest)

  let lro = operation;
  while (!lro.done) {
    console.log('Aguardando a conclusão da geração do vídeo a partir da imagem...');
    await new Promise(resolve => setTimeout(resolve, 15000)); // Espera 15 segundos
    lro = await generativeModel.preview.getOperation(operation.name);
  }

  if (lro.response && lro.response.result && lro.response.result.generatedVideos) {
    const videoUri = lro.response.result.generatedVideos[0].video.uri;
    console.log(`Vídeo gerado com sucesso a partir da imagem! URI do GCS: ${videoUri}`);
    return videoUri;
  } else {
    console.error('Nenhum vídeo gerado a partir da imagem ou resposta inesperada.');
    throw new Error('Falha na geração do vídeo: resposta inesperada da API.');
  }
}

const CONFIG = {
  serviceAccountKeyPath: keyFilePath
};

async function getAccessToken() {
  try {
    // Inicializa o cliente do Cloud Storage
    const storage = new Storage({
      keyFilename: CONFIG.serviceAccountKeyPath
    });

    // Obtém o token de acesso
    const [token] = await storage.authClient.getAccessToken();

    console.log('Token obtido com sucesso!', [token]);
    return {
      access_token: token,
      token_type: 'Bearer'
    };
  } catch (error) {
    console.error('Erro ao obter token:', error);
    throw error;
  }
}

app.post('/generate-video/from-image', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Nenhum arquivo de imagem foi enviado.' });
  }

  const { aspectRatio, durationSeconds, personGeneration } = req.body;
  const localFilePath = req.file.path; // Caminho temporário do arquivo uploadado
  const originalFileName = req.file.originalname;

  if (!aspectRatio) {
    // Limpa o arquivo temporário se a validação falhar
    fs.unlinkSync(localFilePath);
    return res.status(400).json({ error: 'O campo "aspectRatio" é obrigatório.' });
  }

  if (!['16:9', '9:16'].includes(aspectRatio)) {
    fs.unlinkSync(localFilePath);
    return res.status(400).json({ error: 'aspectRatio deve ser "16:9" ou "9:16".' });
  }

  // Gerar um nome único para o arquivo no GCS e para o vídeo de saída
  const timestamp = Date.now();
  const imageFileName = `input-image-${timestamp}-${path.basename(originalFileName)}`;
  const outputVideoFileName = `video_from_image_${timestamp}.mp4`;

  let uploadedImageGcsUri;
  try {
    // 1. Fazer upload da imagem temporária para o GCS
    uploadedImageGcsUri = await uploadImageToGCS(localFilePath, imageFileName);

    // 2. Determinar o MIME type da imagem
    const mimeType = req.file.mimetype;
    if (!mimeType.startsWith('image/')) {
      throw new Error('Tipo de arquivo não é uma imagem.');
    }

    // 3. Gerar o vídeo a partir da imagem no GCS
    const videoUri = await generateVideoFromImage({
      imageGcsUri: uploadedImageGcsUri,
      mimeType: mimeType,
      aspectRatio: aspectRatio,
      outputFileName: outputVideoFileName,
      durationSeconds: parseInt(durationSeconds) || 8, // Converte para número
      personGeneration: personGeneration || 'allow_adult'
    });

    res.status(200).json({ message: 'Vídeo gerado com sucesso!', videoUri: videoUri });

  } catch (error) {
    console.error('Erro na rota /generate-video/from-image:', error);
    res.status(500).json({ error: 'Erro ao gerar vídeo', details: error.message });
  } finally {
    // Sempre remove o arquivo temporário após o processamento 
    if (fs.existsSync(localFilePath)) {
      fs.unlinkSync(localFilePath);
      console.log(`Arquivo temporário ${localFilePath} removido.`);
    }
  }
});

// Rota para verificar status da operação
app.get('/check-video-status/:operationId', async (req, res) => {
  const { operationId } = req.params;

  try {
    const operationName = `projects/${project}/locations/${location}/publishers/google/models/${publisherModel}/operations/${operationId}`;

    const [operation] = await v1AiClient.getOperation({
      name: operationName,
    });

    if (operation.done) {
      if (operation.response) {
        res.status(200).json({
          status: 'SUCCESS',
          videoData: operation.response, // URI do vídeo no GCS, metadados, etc.
        });
      } else if (operation.error) {
        res.status(400).json({
          status: 'ERROR',
          error: operation.error,
        });
      }
    } else {
      res.status(200).json({
        status: 'PENDING',
        message: 'A geração do vídeo ainda está em andamento.',
      });
    }
  } catch (error) {
    console.error('Erro na consulta:', error);
    res.status(500).json({
      status: 'FAILED',
      error: error.message,
    });
  }
});


async function uploadToGCS(file, destinationPath) {
  const options = {
    destination: destinationPath,
    // Optional:
    // Set a generation-match precondition to avoid potential race conditions
    // and data corruptions. The request to upload is aborted if the object's
    // generation number does not match your precondition. For a destination
    // object that does not yet exist, set the ifGenerationMatch precondition to 0
    // If the destination object already exists in your bucket, set instead a
    // generation-match precondition using its generation number.
    preconditionOpts: { ifGenerationMatch: generationMatchPrecondition },
  };

  await storage.bucket(bucketName).upload(filePath, options);
  console.log(`${filePath} uploaded to ${bucketName}`);

  const bucket = storage.bucket(bucketName);
  const fileUpload = bucket.file(destinationPath);

  await fileUpload.save(file.buffer, {
    metadata: {
      contentType: file.mimetype,
    },
  });

  return `gs://${bucketName}/${destinationPath}`;
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

  const userDataFunc = userData.funcionarios || []

  return userDataFunc.filter(([empKey, emp]) => {
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
      selectedEmployee: null,
      selectedProduct: null
    };

    await sendMessageAll({
      phone: `+${phone}`,
      instance: findByInstance.instance,
      token: findByInstance.token,
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
          await sendMessageAll({
            phone: `+${phone}`,
            instance: findByInstance.instance,
            token: findByInstance.token, message: session.questions[0].question
          });
        } else {
          session.step = 'waiting_client_name';
          await sendMessageAll({
            phone: `+${phone}`,
            instance: findByInstance.instance,
            token: findByInstance.token,
            message: "Por favor, digite seu *nome completo* para continuar:"
          });
        }
      } else if (message === '2') {
        const userData = await get(ref(db, `${session.userId}/servicos`)).then(s => s.val());
        const services = userData.servicos
          .map((s, i) =>
            `*${i + 1}. ${s.nome}* - R$ ${s.valor}\n` +
            `${s.descricao || 'Sem descrição disponível'}\n` +
            `──────────────────`
          )
          .join('\n');

        await sendMessageAll({
          phone: `+${phone}`,
          instance: findByInstance.instance,
          token: findByInstance.token,
          message: `💎 *SERVIÇOS DISPONÍVEIS* 💎\n\n${services}\n\n*Digite 1 para iniciar agendamento*`
        });
      } else if (message === '3') {
        // NOVO FLUXO PARA PRODUTOS
        const productsData = await get(ref(db, `${session.userId}/produtos`)).then(s => s.val());

        if (productsData && productsData.produtos && productsData.produtos.length > 0) {
          const productsList = productsData.produtos
            .map((p, i) =>
              `🛍️ *${i + 1}. ${p.nome}* - R$ ${p.valor}\n` +
              `📦 ${p.descricao || 'Produto premium'}\n` +
              (p.estoque ? `📊 Disponível: ${p.estoque} unidades\n` : '') +
              `──────────────────`
            )
            .join('\n');

          session.step = 'selecting_product'; // Novo passo para seleção de produto

          await sendMessageAll({
            phone: `+${phone}`,
            instance: findByInstance.instance,
            token: findByInstance.token,
            message: `🛒 *CATÁLOGO DE PRODUTOS* 🛒\n\n${productsList}\n\n` +
              `Digite o *número* do produto desejado ou\n` +
              `*0* para voltar ao menu principal`
          });
        } else {
          await sendMessageAll({
            phone: `+${phone}`,
            instance: findByInstance.instance,
            token: findByInstance.token,
            message: "⚠️ No momento não temos produtos disponíveis.\n\n" +
              "Digite *1* para agendamento ou *2* para serviços"
          });
        }
      } else {
        // Mensagem de opção inválida atualizada
        await sendMessageAll({
          phone: `+${phone}`,
          instance: findByInstance.instance,
          token: findByInstance.token,
          message: "⚠️ Opção inválida. Por favor, *digite*\n\n" +
            "1️⃣ Para *Iniciar Agendamento*\n" +
            "2️⃣ Para *Ver Serviços*\n" +
            "3️⃣ Para *Ver Produtos*"
        });
      }
      break;

    // 3. Adicione um novo case para lidar com a seleção de produtos
    case 'selecting_product':
      if (message === '0') {
        session.step = 'waiting_initial_choice';
        await sendMessageAll({
          phone: `+${phone}`,
          instance: findByInstance.instance,
          token: findByInstance.token,
          message: "🔙 Voltando ao menu principal:\n\n" +
            "1. Agendamento\n2. Serviços\n3. Produtos"
        });
      } else {
        const productsData = await get(ref(db, `${session.userId}/produtos`)).then(s => s.val());
        const selectedIndex = parseInt(message) - 1;

        if (productsData.produtos[selectedIndex]) {
          session.selectedProduct = productsData.produtos[selectedIndex];
          session.step = 'confirming_product';

          await sendMessageAll({
            phone: `+${phone}`,
            instance: findByInstance.instance,
            token: findByInstance.token,
            message: `✅ *${session.selectedProduct.nome}* selecionado!\n\n` +
              `💵 Valor: R$ ${session.selectedProduct.valor}\n` +
              `📝 ${session.selectedProduct.descricao}\n\n` +
              `Deseja:\n\n` +
              `1. Comprar agora\n` +
              `2. Adicionar ao carrinho\n` +
              `0. Voltar`
          });
        } else {
          await sendMessageAll({
            phone: `+${phone}`,
            instance: findByInstance.instance,
            token: findByInstance.token,
            message: "⚠️ Produto inválido. Por favor, digite o número correto ou 0 para voltar"
          });
        }
      }
      break;

    case 'confirming_product':
      const newAppointment = {
        date: null,
        time: null,
        employee: null,
        employeeName: null,
        service: null,
        serviceValue: null,
        clientPhone: phone,
        clientName: null,
        establishment: null,
        status: 'waiting_initial_choice',
        createdAt: new Date().toISOString(),
        nome:session.selectedProduct
      };

      await push(ref(db, `${session.userId}/compras`), newAppointment);
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
          instance: findByInstance.instance,
          token: findByInstance.token,
          message: `📋 *Resumo das Respostas*\n${summary}\n\nPor favor, digite seu *Nome* para continuar:`
        });
      }
      break;

    case 'waiting_client_name':
      session.clientName = message;
      session.step = 'waiting_date';
      await sendMessageAll({
        phone: `+${phone}`,
        instance: findByInstance.instance,
        token: findByInstance.token,
        message: `👋 *Olá ${session.clientName}!* Informe a data desejada (DD/MM):\n*Exemplo: 25/12*`
      });
      break;


    case 'waiting_date':
      // Verifica formato DD/MM
      if (!/^\d{2}\/\d{2}$/.test(message)) {
        await sendMessageAll({
          phone: `+${phone}`,
          instance: findByInstance.instance,
          token: findByInstance.token,
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
            instance: findByInstance.instance,
            token: findByInstance.token,
            message: "❌ Todos os horários estão ocupados nesta data. *Escolha outra data (DD/MM):*"
          });
          return;
        }

        // Atualiza sessão
        session.selectedDate = formattedDate;
        session.step = 'waiting_time';

        await sendMessageAll({
          phone: `+${phone}`,
          instance: findByInstance.instance,
          token: findByInstance.token,
          message: `⏰ *Horários disponíveis para ${message}:*\n${availableTimes.map(t => `• ${t}`).join('\n')}\n\n*Digite o horário desejado: *Exemplo: 10:00**`
        });

      } catch (error) {
        console.error("Erro ao buscar horários:", error);
        await sendMessageAll({
          phone: `+${phone}`,
          instance: findByInstance.instance,
          token: findByInstance.token,
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
          instance: findByInstance.instance,
          token: findByInstance.token,
          message: `💇 Serviços disponíveis:\n${services}\n\n*Digite o número do serviço:*`
        });
      } else {
        const availableTimes = await getAvailableTimes(session.userId, session.selectedDate);
        await sendMessageAll({
          phone: `+${phone}`,
          instance: findByInstance.instance,
          token: findByInstance.token,
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
              instance: findByInstance.instance,
              token: findByInstance.token,
              message: `👤 Profissionais disponíveis:\n${employeesList}\n\nDigite o número do profissional:`
            });
          } else {
            await sendMessageAll({
              phone: `+${phone}`,
              instance: findByInstance.instance,
              token: findByInstance.token,
              message: "❌ Nenhum profissional disponível. Escolha outro horário:"
            });
            session.step = 'waiting_time';
          }
        }
      } else {
        await sendMessageAll({
          phone: `+${phone}`,
          instance: findByInstance.instance,
          token: findByInstance.token,
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
            instance: findByInstance.instance,
            token: findByInstance.token,
            message: `✅ Agendamento confirmado com ${selectedEmp.nome}!\n📅 ${newAppointment.date} às ${newAppointment.time}\n💼 ${newAppointment.service}\n💰 R$ ${newAppointment.serviceValue}`
          });

          await sendMessageAll({
            phone: `+${phone}`,
            instance: findByInstance.instance,
            token: findByInstance.token,
            message: `Para *Agendar Novamente* nesse local use o código nos envie o código a abaixo`
          });

          await sendMessageAll({
            phone: `+${phone}`,
            instance: findByInstance.instance,
            token: findByInstance.token,
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
            instance: findByInstance.instance,
            token: findByInstance.token,
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


app.post('/auth/refresh', async (req, res,) => {
  const { userId } = req.body;

  let margin = 300
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
configureWebhook()
});