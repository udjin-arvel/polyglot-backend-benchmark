FROM golang:1.23-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /server .

FROM alpine:3.20
RUN apk add --no-cache ca-certificates wget \
  && adduser -D -u 65532 -h /home/app app
COPY --from=build /server /server
USER app
WORKDIR /home/app
ENV PORT=8081
EXPOSE 8081
ENTRYPOINT ["/server"]
