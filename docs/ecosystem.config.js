
// // pm2 delete langchain-pg; pm2 start langchain-pg; pm2 logs langchain-pg;

// const path = require('path');
// const dotenv = require('dotenv');
// const fs = require('fs');

// // ---pg-service--- Загрузка переменных из .env файла
// const pgServiceEnvPath = path.resolve(__dirname, 'pg-service/.env');
// let pgServiceEnv = {};
// if (fs.existsSync(pgServiceEnvPath)) {
//   pgServiceEnv = dotenv.parse(fs.readFileSync(pgServiceEnvPath));
// }

// // ---pg-service--- Загрузка переменных из .env файла
// const langchainPgServiceEnvPath = path.resolve(__dirname, 'langchain-pg/.env');
// let langchainPgServiceEnv = {};
// if (fs.existsSync(langchainPgServiceEnvPath)) {
//   langchainPgServiceEnv = dotenv.parse(fs.readFileSync(langchainPgServiceEnvPath));
// }


module.exports = {
  deploy: {
    production: {
      'post-deploy': 'pm2 reload ecosystem.config.js --env production'
    }
  },
  apps: [
    {
      name: 'kosmos-ssh',
      script: 'server.js',
      __interpreter: 'C:\\Program Files\\nodejs\\node.exe',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      cwd: './kosmos-ssh',
      env: {
        NODE_ENV: 'development',
        WEB_PORT: 3001,
        AUTO_START_TUNNEL: 'true',
        LOG_LEVEL: 'info'
      },
      env_production: {
        NODE_ENV: 'production',
        WEB_PORT: 3001,
        AUTO_START_TUNNEL: 'true',
        LOG_LEVEL: 'info'
      }
    },
    {
      name: 'kosmos-model',
      cwd: './kosmos-model',
      script: 'server.js',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'development',
        PORT: 3002
      },
      env_production: {
        NODE_ENV: 'production',
        PORT: 3002
      }
    },
    {
      name: 'kosmos-panel',
      cwd: './kosmos-panel',
      script: 'server/index.js',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'development',
        PORT: 3000
      },
      env_production: {
        NODE_ENV: 'production',
        PORT: 3000
      }
    },
{
  name: 'aian-vector',
  
  // Этот путь должен вести в корень твоего проекта
  cwd: './aian-vector',
  
  // Самое главное изменение: запускаем новый сервер
  script: 'server-v2/index.js',
  
  instances: 1,
  autorestart: true,
  watch: false,
  max_memory_restart: '1G',
  env: {
    NODE_ENV: 'development',
    PORT: 3005
  },
  env_production: {
    NODE_ENV: 'production',
    PORT: 3005
  }
},
    {
      name: 'eng_verbs',
      cwd: './eng_verbs',
      script: 'server.js',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'development',
        PORT: 3010
      },
      env_production: {
        NODE_ENV: 'production',
        PORT: 3010
      }
    },
    {
      name: 'kosmos-file',
      cwd: './kosmos-file',
      script: 'server.js',
      instances: 1,
      autorestart: true,
      watch: false,
      cwd: './kosmos-file',
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'development',
        PORT: 3003
      },
      env_production: {
        NODE_ENV: 'production',
        PORT: 3003
      }
    }
  ]
};