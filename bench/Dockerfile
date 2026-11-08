FROM grafana/k6:latest
USER root
RUN apk add --no-cache bash curl jq
COPY run-all.sh /bench/run-all.sh
RUN chmod +x /bench/run-all.sh
WORKDIR /bench
ENTRYPOINT ["/bin/bash"]
CMD ["/bench/run-all.sh"]
