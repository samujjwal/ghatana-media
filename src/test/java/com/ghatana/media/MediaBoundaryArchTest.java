package com.ghatana.media;

import com.tngtech.archunit.junit.AnalyzeClasses;
import com.tngtech.archunit.junit.ArchTest;
import com.tngtech.archunit.lang.ArchRule;

import static com.tngtech.archunit.library.dependencies.SlicesRuleDefinition.slices;
import static com.tngtech.archunit.lang.syntax.ArchRuleDefinition.noClasses;

/**
 * ArchUnit boundary tests for the Media service.
 *
 * @doc.type class
 * @doc.purpose Enforce module boundaries and cross-service constraints for Media
 * @doc.layer test
 * @doc.pattern ArchTest
 */
@AnalyzeClasses(packages = "com.ghatana.media")
class MediaBoundaryArchTest {

    @ArchTest
    static final ArchRule media_must_not_depend_on_data_cloud_internals =
            noClasses().that().resideInAPackage("com.ghatana.media..")
                    .should().dependOnClassesThat().resideInAPackage("com.ghatana.datacloud..")
                    .because("Media must use Data Cloud via API contracts only");

    @ArchTest
    static final ArchRule media_must_not_depend_on_agents =
            noClasses().that().resideInAPackage("com.ghatana.media..")
                    .should().dependOnClassesThat().resideInAPackage("com.ghatana.agents..")
                    .because("Media must not directly depend on Agents internals");

    @ArchTest
    static final ArchRule media_must_not_depend_on_action_plane =
            noClasses().that().resideInAPackage("com.ghatana.media..")
                    .should().dependOnClassesThat().resideInAPackage("com.ghatana.actionplane..")
                    .because("Media must not directly depend on Action Plane internals");

    @ArchTest
    static final ArchRule media_must_not_have_circular_dependencies =
            slices().matching("com.ghatana.media.(*)..")
                    .should().beFreeOfCycles();
}
