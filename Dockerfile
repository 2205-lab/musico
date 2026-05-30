FROM node:18

RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    python3-dev \
    ffmpeg \
    libsndfile1 \
    && rm -rf /var/lib/apt/lists/*

RUN pip3 install --break-system-packages \
    scipy==1.10.1 \
    numpy==1.24.3 \
    librosa==0.10.1 \
    soundfile==0.12.1 \
    audioread==3.0.1

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

CMD ["node", "app.js"]
