package com.ghatana.media.provider.aws;

import org.flywaydb.core.Flyway;

import java.nio.file.Files;
import java.nio.file.Path;

/** Child JVM for the IP-06 Flyway process-death rehearsal. */
public final class MediaIp06FlywayCrashWorker {
    private MediaIp06FlywayCrashWorker() { }

    public static void main(String[] args) throws Exception {
        if (args.length != 7) throw new IllegalArgumentException("url,user,password,schema,locations,target,result required");
        Flyway flyway = Flyway.configure()
                .dataSource(args[0], args[1], args[2])
                .locations(args[4].split(","))
                .schemas(args[3])
                .defaultSchema(args[3])
                .group(false)
                .validateMigrationNaming(true)
                .target(args[5])
                .load();
        int executed = flyway.migrate().migrationsExecuted;
        Files.writeString(Path.of(args[6]), "MIGRATED:" + executed);
    }
}
