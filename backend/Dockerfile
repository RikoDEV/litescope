FROM golang:1.22-alpine AS builder
WORKDIR /src
COPY go.mod ./
RUN go mod download -x
COPY . .
# tidy runs after source is present so it can resolve imports and write go.sum
RUN go mod tidy
RUN CGO_ENABLED=0 go build -ldflags="-s -w" -o /bin/ingestor ./cmd/ingestor
RUN CGO_ENABLED=0 go build -ldflags="-s -w" -o /bin/server  ./cmd/server

FROM alpine:3.19
RUN apk add --no-cache ca-certificates tzdata supervisor
WORKDIR /app
COPY --from=builder /bin/ingestor /bin/server ./
COPY supervisord.conf /etc/supervisord.conf
EXPOSE 3000
CMD ["supervisord", "-c", "/etc/supervisord.conf"]
