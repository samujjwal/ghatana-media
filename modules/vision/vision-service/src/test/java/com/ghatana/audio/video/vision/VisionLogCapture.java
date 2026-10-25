package com.ghatana.audio.video.vision;

import org.apache.logging.log4j.Level;
import org.apache.logging.log4j.LogManager;
import org.apache.logging.log4j.core.Filter;
import org.apache.logging.log4j.core.LogEvent;
import org.apache.logging.log4j.core.LoggerContext;
import org.apache.logging.log4j.core.appender.AbstractAppender;
import org.apache.logging.log4j.core.layout.PatternLayout;

import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

/** Test-only appender for assertions over formatted ordinary application logs. */
public final class VisionLogCapture implements AutoCloseable {
    private final LoggerContext context;
    private final org.apache.logging.log4j.core.Logger logger;
    private final Level previousLevel;
    private final boolean previousAdditive;
    private final CapturingAppender appender;

    public VisionLogCapture(Class<?> source) {
        context = (LoggerContext) LogManager.getContext(false);
        logger = context.getLogger(source.getName());
        previousLevel = logger.getLevel();
        previousAdditive = logger.isAdditive();
        appender = new CapturingAppender("vision-test-" + UUID.randomUUID());
        appender.start();
        logger.addAppender(appender);
        logger.setLevel(Level.ALL);
        logger.setAdditive(false);
    }

    public List<String> messages() {
        return List.copyOf(appender.messages);
    }

    public List<Throwable> throwables() {
        return List.copyOf(appender.throwables);
    }

    @Override
    public void close() {
        logger.removeAppender(appender);
        logger.setLevel(previousLevel);
        logger.setAdditive(previousAdditive);
        appender.stop();
        context.updateLoggers();
    }

    private static final class CapturingAppender extends AbstractAppender {
        private final List<String> messages = new ArrayList<>();
        private final List<Throwable> throwables = new ArrayList<>();

        private CapturingAppender(String name) {
            super(name, (Filter) null, PatternLayout.createDefaultLayout(), true);
        }

        @Override
        public void append(LogEvent event) {
            messages.add(event.getMessage().getFormattedMessage());
            if (event.getThrown() != null) {
                throwables.add(event.getThrown());
            }
        }
    }
}
