# Box for Less — Production Container
# Node >= 22 required for native node:sqlite (DatabaseSync)
FROM node:22-alpine AS runtime

WORKDIR /app

# Install dependencies (production only)
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy application source code
COPY src/ ./src/
COPY data/ ./data/

# Environment defaults
ENV NODE_ENV=production
ENV PORT=3000
ENV BFL_HOST=0.0.0.0
ENV BFL_DB_PATH=/app/data/product_master.db
ENV BFL_UPLOADS_DIR=/app/data/uploads
ENV BFL_PRODUCT_IMAGES_DIR=/app/data/product-images

# Create data directory and volume mount point for persistent storage
RUN mkdir -p /app/data /app/data/uploads /app/data/product-images

# Expose internal HTTP port
EXPOSE 3000

# Health check endpoint
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:3000/api/health || exit 1

# Run database migrations and start server
CMD ["sh", "-c", "npm run migrate && npm start"]
