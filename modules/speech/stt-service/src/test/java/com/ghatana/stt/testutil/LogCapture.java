package com.ghatana.stt.testutil;

import org.apache.logging.log4j.Level;
import org.apache.logging.log4j.core.LogEvent;
import org.apache.logging.log4j.core.LoggerContext;
import org.apache.logging.log4j.core.appender.AbstractAppender;
import org.apache.logging.log4j.core.config.Property;

import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;

/** Captures one SLF4J-backed Log4j logger for privacy regression tests. */
public final class LogCapture extends AbstractAppender implements AutoCloseable {
    private final org.apache.logging.log4j.core.Logger logger;
    private final Level previousLevel;
    private final List<String> messages = new CopyOnWriteArrayList<>();

    private LogCapture(String name, org.apache.logging.log4j.core.Logger logger) {
        super(name, null, null, true, Property.EMPTY_ARRAY);
        this.logger = logger;
        this.previousLevel = logger.getLevel();
        start();
        logger.addAppender(this);
        logger.setLevel(Level.DEBUG);
    }

    public static LogCapture capture(Class<?> loggerType) {
        LoggerContext context = (LoggerContext) org.apache.logging.log4j.LogManager.getContext(false);
        org.apache.logging.log4j.core.Logger logger = context.getLogger(loggerType.getName());
        return new LogCapture("stt-redaction-" + loggerType.getSimpleName(), logger);
    }

    @Override
    public void append(LogEvent event) {
        messages.add(event.getMessage().getFormattedMessage());
    }

    public String output() {
        return String.join("\n", messages);
    }

    @Override
    public void close() {
        logger.removeAppender(this);
        logger.setLevel(previousLevel);
        stop();
    }
}
