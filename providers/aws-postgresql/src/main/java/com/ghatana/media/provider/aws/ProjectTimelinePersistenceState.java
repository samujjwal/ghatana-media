package com.ghatana.media.provider.aws;

import tools.jackson.databind.ObjectMapper;

import java.sql.Connection;

/** Package boundary for project timeline JDBC access and lifecycle ownership. */
interface ProjectTimelinePersistenceState extends AutoCloseable {
    Connection connection();
    ObjectMapper mapper();
    void release();
    @Override void close();
}
