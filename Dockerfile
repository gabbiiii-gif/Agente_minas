# Imagem do gateway. O importador de catálogo NÃO entra aqui: ele é CLI de
# máquina de desenvolvedor, lê planilha do ERP e não roda na VPS.
FROM node:22-alpine

WORKDIR /app

# Dependências primeiro, numa camada só: código muda toda hora, package-lock
# quase nunca. Assim o rebuild depois de mexer no prompt não baixa npm de novo.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY supabase ./supabase

# `tsx` roda TypeScript direto: sem passo de build, o que sobe é exatamente o
# que está no repositório. Vale enquanto o serviço é um processo só.
ENV NODE_ENV=production
EXPOSE 3000

CMD ["npx", "tsx", "src/gateway/servidor.ts"]
