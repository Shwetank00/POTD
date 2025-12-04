# Use a base image that supports Puppeteer
FROM ghcr.io/puppeteer/puppeteer:latest

# Switch to root to install dependencies if needed (though the base image is usually good)
USER root

# Set working directory
WORKDIR /usr/src/app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci

# Copy the rest of the app
COPY . .

# Expose the port
EXPOSE 3000

# Start the server
CMD [ "node", "server.js" ]