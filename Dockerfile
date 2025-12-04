# Use the official Puppeteer image which comes with Chrome installed
FROM ghcr.io/puppeteer/puppeteer:latest

# Switch to root user to install dependencies (if any extra are needed)
USER root

# Set the working directory
WORKDIR /usr/src/app

# Copy package.json and install dependencies
COPY package*.json ./
RUN npm install

# Copy the rest of the application code
COPY . .

# Expose the web server port
EXPOSE 3000

# Start the server
CMD [ "node", "server.js" ]