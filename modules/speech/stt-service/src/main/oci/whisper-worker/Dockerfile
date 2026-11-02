ARG BASE_IMAGE
FROM ${BASE_IMAGE}

WORKDIR /opt/stt
COPY install/ /opt/stt/

# The image starts exactly one request/response worker. The broker must not pass
# an entrypoint or command override; all request data arrives as one bounded stdin frame.
ENTRYPOINT ["java", "-cp", "/opt/stt/lib/*", "com.ghatana.stt.provider.WhisperComputeWorkerMain"]
