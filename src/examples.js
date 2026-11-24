// Example Jenkinsfiles. Each may bring its own run contexts.

const multibranch = `pipeline {
    agent any

    options {
        timeout(time: 30, unit: 'MINUTES')
        disableConcurrentBuilds()
    }

    parameters {
        booleanParam(name: 'SKIP_TESTS', defaultValue: false, description: 'Skip the test stages')
    }

    environment {
        APP      = 'shop-api'
        REGISTRY = 'registry.example.com'
    }

    stages {
        stage('Checkout') {
            steps {
                checkout scm
                script {
                    env.GIT_SHORT = sh(script: 'git rev-parse --short HEAD', returnStdout: true).trim()
                }
                echo "Building \${APP} at \${env.GIT_SHORT} on \${env.BRANCH_NAME}"
            }
        }

        stage('Build') {
            steps {
                sh './gradlew assemble'
            }
        }

        stage('Tests') {
            when {
                not { expression { params.SKIP_TESTS } }
            }
            parallel {
                stage('Unit') {
                    steps { sh './gradlew test' }
                    post { always { junit 'build/test-results/test/*.xml' } }
                }
                stage('Integration') {
                    steps { sh './gradlew integrationTest' }
                }
                stage('Lint') {
                    steps { sh './gradlew spotlessCheck' }
                }
            }
        }

        stage('Docker image') {
            when {
                anyOf { branch 'main'; buildingTag() }
            }
            steps {
                sh "docker build -t \${REGISTRY}/\${APP}:\${env.GIT_SHORT} ."
                sh "docker push \${REGISTRY}/\${APP}:\${env.GIT_SHORT}"
            }
        }

        stage('Deploy to staging') {
            when { branch 'main' }
            steps {
                sh "helm upgrade --install \${APP} chart/ --set image.tag=\${env.GIT_SHORT} -n staging"
            }
        }

        stage('Deploy to production') {
            when {
                beforeInput true
                buildingTag()
            }
            input {
                message 'Deploy to production?'
                ok 'Ship it'
            }
            steps {
                sh "helm upgrade --install \${APP} chart/ --set image.tag=\${env.TAG_NAME} -n production"
            }
        }
    }

    post {
        success { echo 'All good' }
        failure {
            slackSend channel: '#ci', message: "Build failed: \${env.JOB_NAME} #\${env.BUILD_NUMBER}"
        }
        fixed {
            slackSend channel: '#ci', message: "Back to green: \${env.JOB_NAME}"
        }
        always { cleanWs() }
    }
}
`;

const monorepo = `// Monorepo: build only what changed.
pipeline {
    agent none

    stages {
        stage('Frontend') {
            when {
                beforeAgent true
                changeset 'frontend/**'
            }
            agent { docker { image 'node:20-alpine' } }
            stages {
                stage('Install') { steps { sh 'npm ci --prefix frontend' } }
                stage('Test')    { steps { sh 'npm test --prefix frontend' } }
                stage('Bundle')  { steps { sh 'npm run build --prefix frontend' } }
            }
        }

        stage('Backend') {
            when {
                anyOf {
                    changeset 'backend/**'
                    changeset 'build.gradle'
                }
            }
            agent { label 'linux' }
            steps {
                sh './gradlew :backend:build'
            }
        }

        stage('Docs') {
            when {
                allOf {
                    branch 'main'
                    changeset pattern: 'docs/**/*.md', caseSensitive: true
                }
            }
            agent any
            steps {
                sh 'mkdocs build'
                sh 'aws s3 sync site/ s3://docs.example.com'
            }
        }

        stage('Release notes') {
            when { changelog '.*\\\\[release\\\\].*' }
            steps {
                echo 'Commit asks for a release'
            }
        }
    }
}
`;

const monorepoContexts = [
  { name: 'Frontend change', kind: 'branch', branch: 'main', changedFiles: ['frontend/src/App.tsx', 'frontend/package.json'], commits: ['Tweak checkout button'] },
  { name: 'Backend change (PR)', kind: 'pr', pr: { id: 77, target: 'main', source: 'fix/orders', author: 'bob', title: 'Fix order totals' }, changedFiles: ['backend/src/main/java/Orders.java'], commits: ['Fix order totals'] },
  { name: 'Docs on main', kind: 'branch', branch: 'main', changedFiles: ['docs/guide/setup.md'], commits: ['Docs: setup guide'] },
  { name: 'Docs (wrong case)', kind: 'branch', branch: 'main', changedFiles: ['docs/guide/SETUP.MD'], commits: ['Docs: rename'] },
  { name: 'Release commit', kind: 'branch', branch: 'main', changedFiles: ['build.gradle'], commits: ['Bump version [release]'] },
  { name: 'First build of branch', kind: 'branch', branch: 'feature/new', changedFiles: [], commits: ['Initial commit'] },
];

const matrix = `pipeline {
    agent none
    stages {
        stage('Build & test') {
            matrix {
                axes {
                    axis {
                        name 'PLATFORM'
                        values 'linux', 'windows', 'mac'
                    }
                    axis {
                        name 'JDK'
                        values '17', '21'
                    }
                }
                excludes {
                    exclude {
                        axis { name 'PLATFORM'; values 'mac' }
                        axis { name 'JDK'; values '17' }
                    }
                }
                agent { label "\${PLATFORM}" }
                stages {
                    stage('Build') {
                        steps {
                            echo "Building on \${PLATFORM} with JDK \${JDK}"
                            sh "./gradlew build -PjavaVersion=\${JDK}"
                        }
                    }
                    stage('Windows smoke test') {
                        when { environment name: 'PLATFORM', value: 'windows' }
                        steps {
                            bat 'run-smoke.cmd'
                        }
                    }
                }
            }
        }
        stage('Publish') {
            when { branch 'main' }
            agent any
            steps {
                sh './gradlew publish'
            }
        }
    }
}
`;

const matrixContexts = [
  { name: 'Push to main', kind: 'branch', branch: 'main', changedFiles: ['src/Lib.java'] },
  { name: 'Windows build breaks', kind: 'branch', branch: 'main', changedFiles: ['src/Lib.java'], mocks: [{ match: 'run-smoke.cmd', exitCode: 1, stdout: 'smoke test failed: service did not start' }] },
  { name: 'Pull request', kind: 'pr', pr: { id: 9, target: 'main', source: 'feature/x', author: 'carol', title: 'Speed up' }, changedFiles: ['src/Lib.java'] },
];

const scripted = `@Library('ci-shared') _

properties([
    parameters([
        booleanParam(name: 'DEPLOY', defaultValue: false, description: 'Deploy after the build')
    ]),
    pipelineTriggers([cron('H 2 * * *')])
])

def isRelease = env.BRANCH_NAME ==~ /release\\/.*/

node('linux') {
    stage('Checkout') {
        checkout scm
    }

    stage('Build') {
        sh 'mvn -B -DskipTests package'
    }

    stage('Test') {
        try {
            sh 'mvn -B verify'
        } catch (err) {
            currentBuild.result = 'UNSTABLE'
            echo "Tests failed: \${err.message}"
        }
    }

    if (env.BRANCH_NAME == 'main' || isRelease) {
        stage('Publish') {
            sh 'mvn -B deploy -DskipTests'
        }
    }

    if (params.DEPLOY && isRelease) {
        stage('Deploy') {
            deployTo('production')
        }
    } else {
        echo 'Not deploying: DEPLOY is off or this is not a release branch'
    }

    def regions = isRelease ? ['eu-west-1', 'us-east-1'] : []
    for (region in regions) {
        stage("Smoke \${region}") {
            sh "./smoke.sh --region \${region}"
        }
    }
}

def deployTo(String envName) {
    echo "Deploying to \${envName}"
    sh "kubectl --context \${envName} apply -f k8s/"
}
`;

const scriptedContexts = [
  { name: 'Push to main', kind: 'branch', branch: 'main', changedFiles: ['src/App.java'] },
  { name: 'release/2.0, DEPLOY', kind: 'branch', branch: 'release/2.0', cause: 'user', params: { DEPLOY: true }, changedFiles: ['pom.xml'] },
  { name: 'Feature branch, tests fail', kind: 'branch', branch: 'feature/cart', changedFiles: ['src/Cart.java'], mocks: [{ match: 'mvn -B verify', exitCode: 1 }] },
  { name: 'Build fails', kind: 'branch', branch: 'main', mocks: [{ match: 'package', exitCode: 1, stdout: '[ERROR] COMPILATION ERROR' }] },
];

const params = `pipeline {
    agent any

    triggers {
        cron(env.BRANCH_NAME == 'main' ? 'H 3 * * *' : '')
    }

    parameters {
        string(name: 'VERSION', defaultValue: '', description: 'Release version; empty builds a snapshot')
        choice(name: 'TARGET', choices: ['staging', 'production'], description: 'Where to deploy')
        booleanParam(name: 'RUN_E2E', defaultValue: false, description: 'Run the slow end-to-end suite')
    }

    stages {
        stage('Build') {
            steps {
                sh './build.sh'
            }
        }

        stage('Flaky integration') {
            options { retry(2) }
            steps {
                sh './integration.sh'
            }
        }

        stage('End-to-end') {
            when {
                anyOf {
                    triggeredBy 'TimerTrigger'
                    expression { params.RUN_E2E }
                }
            }
            steps {
                sh './e2e.sh'
            }
        }

        stage('Release') {
            when {
                branch 'main'
                expression { return params.VERSION?.trim() }
            }
            steps {
                script {
                    def version = params.VERSION.trim()
                    if (!(version ==~ /\\d+\\.\\d+\\.\\d+/)) {
                        error "VERSION must look like 1.2.3, got '\${version}'"
                    }
                    if (params.TARGET == 'production') {
                        echo "Releasing \${version} to production"
                        sh "./release.sh \${version} --prod"
                    } else {
                        echo "Releasing \${version} to staging only"
                        sh "./release.sh \${version}"
                    }
                }
            }
        }
    }

    post {
        unsuccessful {
            mail to: 'team@example.com', subject: "Build \${currentBuild.currentResult}", body: env.BUILD_URL
        }
    }
}
`;

const paramsContexts = [
  { name: 'Push to main', kind: 'branch', branch: 'main', changedFiles: ['src/App.java'] },
  { name: 'Nightly', kind: 'branch', branch: 'main', cause: 'timer' },
  { name: 'Manual 1.4.0 → production', kind: 'branch', branch: 'main', cause: 'user', user: 'dana', params: { VERSION: '1.4.0', TARGET: 'production' } },
  { name: 'Manual bad version', kind: 'branch', branch: 'main', cause: 'user', params: { VERSION: 'latest' } },
  { name: 'Integration flaky once', kind: 'branch', branch: 'main', mocks: [{ match: 'integration.sh', exitCode: 1, times: 1, stdout: 'Connection refused' }] },
  { name: 'Integration broken', kind: 'branch', branch: 'main', mocks: [{ match: 'integration.sh', exitCode: 1 }] },
];

const mistakes = `// This file has the mistakes Jenkins rejects most often.
// Open the Problems list to see each one.
pipeline {
    agent any
    stages {
        stage('Build') {
            sh 'make'
        }
        stage('Test') {
            steps {
                def status = sh(script: 'make test', returnStatus: true)
            }
        }
        stage('Deploy') {
            when { branches 'main' }
            steps {
                withCredentials([string(credentialsId: 'deploy-token', variable: 'TOKEN')]) {
                    sh "curl -H 'Authorization: Bearer \${TOKEN}' https://deploy.example.com"
                }
            }
        }
        stage('Build') {
            steps { echo 'again' }
        }
    }
    post {
        failed { echo 'oops' }
    }
}
`;

const secrets = `pipeline {
    agent any
    environment {
        DEPLOY_TOKEN = credentials('deploy-token')
    }
    stages {
        stage('Deploy') {
            when { branch 'main' }
            steps {
                // Groovy interpolation: Jenkins warns that the secret leaks into the process list
                sh "curl -H 'Authorization: Bearer \${DEPLOY_TOKEN}' https://deploy.example.com/hooks"
                // Single quotes: the shell expands the variable, nothing leaks
                sh 'curl -H "Authorization: Bearer $DEPLOY_TOKEN" https://deploy.example.com/hooks'
            }
        }
        stage('Approve') {
            when { branch 'main' }
            steps {
                input message: 'Promote to production?'
            }
        }
    }
}
`;

const chain = `pipeline {
    agent any

    parameters {
        choice(name: 'BUILD_TYPE', choices: ['Snapshot', 'PreRelease', 'Release'], description: 'What this build produces')
        string(name: 'VERSION', defaultValue: '1.4.0', description: 'Version to pre-release or release')
        booleanParam(name: 'DEPLOY_STAGING', defaultValue: true, description: 'Deploy the release candidate to staging')
    }

    stages {
        stage('Build') {
            steps {
                checkout scm
                sh './gradlew assemble'
            }
        }

        stage('Unit tests') {
            steps {
                sh './gradlew test'
            }
        }

        // main: start the prerelease branch of this same multibranch project
        stage('Start pre-release') {
            when {
                branch 'main'
                expression { params.BUILD_TYPE == 'PreRelease' }
            }
            steps {
                script {
                    def project = env.JOB_NAME.split('/')[0]
                    def rc = build(job: "\${project}/prerelease", parameters: [
                        string(name: 'VERSION', value: "\${params.VERSION}-rc.\${env.BUILD_NUMBER}"),
                        booleanParam(name: 'DEPLOY_STAGING', value: params.DEPLOY_STAGING)
                    ])
                    echo "Pre-release build #\${rc.number} finished: \${rc.result}"
                }
            }
        }

        // prerelease: the build started above
        stage('Pre-release') {
            when { branch 'prerelease' }
            stages {
                stage('Integration tests') {
                    steps {
                        sh './gradlew integrationTest'
                    }
                }
                stage('Publish RC') {
                    steps {
                        sh "./gradlew publish -Pversion=\${params.VERSION}"
                    }
                }
                stage('Deploy to staging') {
                    when { expression { params.DEPLOY_STAGING } }
                    steps {
                        // a separate job, started without waiting for it
                        build job: 'deploy-staging', wait: false, parameters: [
                            string(name: 'VERSION', value: params.VERSION),
                            string(name: 'TARGET', value: 'staging')
                        ]
                    }
                }
            }
        }

        stage('Release') {
            when {
                branch 'main'
                expression { params.BUILD_TYPE == 'Release' }
            }
            steps {
                sh "./gradlew release -Pversion=\${params.VERSION}"
            }
        }
    }

    post {
        failure {
            echo "Tell #releases: \${currentBuild.fullDisplayName} failed"
        }
    }
}
`;

const deployStaging = `pipeline {
    agent any

    parameters {
        string(name: 'VERSION', defaultValue: '', description: 'Image tag to deploy')
        choice(name: 'TARGET', choices: ['staging', 'production'], description: 'Where to deploy')
    }

    stages {
        stage('Validate') {
            steps {
                script {
                    if (!params.VERSION) {
                        error 'VERSION is required'
                    }
                }
            }
        }
        stage('Deploy') {
            steps {
                sh "helm upgrade --install shop-api charts/shop-api -n \${params.TARGET} --set image.tag=\${params.VERSION}"
            }
        }
        stage('Smoke test') {
            steps {
                sh "curl -fsS https://\${params.TARGET}.shop.example.com/health"
            }
        }
    }
}
`;

const chainContexts = [
  { name: 'Push to main', kind: 'branch', branch: 'main', changedFiles: ['src/App.java'] },
  { name: 'Manual: PreRelease', kind: 'branch', branch: 'main', cause: 'user', params: { BUILD_TYPE: 'PreRelease' } },
  { name: 'PreRelease, IT fails', kind: 'branch', branch: 'main', cause: 'user', params: { BUILD_TYPE: 'PreRelease' }, mocks: [{ match: 'integrationTest', exitCode: 1, stdout: 'CheckoutIT > pays with a saved card FAILED' }] },
  { name: 'Manual: Release', kind: 'branch', branch: 'main', cause: 'user', params: { BUILD_TYPE: 'Release' } },
];

export const EXAMPLES = [
  { id: 'multibranch', title: 'Build, test, deploy (multibranch)', blurb: 'Push, PR, tag and nightly builds of one multibranch pipeline: parallel tests, a Docker image, and deploys gated by when.', tag: 'Declarative', hue: '#7c93ff', source: multibranch, contexts: null },
  { id: 'monorepo', title: 'Monorepo: changeset and changelog', blurb: 'Build only what changed: changeset, changelog and beforeAgent, including the first build of a branch, which has no changeset.', tag: 'Declarative', hue: '#3fcf8e', source: monorepo, contexts: monorepoContexts },
  { id: 'matrix', title: 'Matrix build with excludes', blurb: 'Six platform × JDK cells minus an exclude, a per-cell when, and a Windows-only smoke test that fails.', tag: 'Matrix', hue: '#5aa9ff', source: matrix, contexts: matrixContexts },
  { id: 'params', title: 'Parameters, retry, triggeredBy', blurb: "Build parameters, triggeredBy 'TimerTrigger', a stage retry that recovers from a flaky test, and input validation that fails the build.", tag: 'Parameters', hue: '#f5b041', source: params, contexts: paramsContexts },
  { id: 'chain', title: 'Pre-release: one pipeline starts another', blurb: 'A BUILD_TYPE parameter decides: main builds, then starts the prerelease branch, which hands the release candidate to a separate deploy job.', tag: 'Downstream', hue: '#2dd4bf', source: chain, jobs: [{ name: 'deploy-staging', source: deployStaging }], contexts: chainContexts },
  { id: 'scripted', title: 'Scripted pipeline (node / if / loops)', blurb: 'node, if/else, try/catch and a loop of stages. A stage that never ran says which if was false.', tag: 'Scripted', hue: '#c58bff', source: scripted, contexts: scriptedContexts },
  { id: 'secrets', title: 'Credentials and input', blurb: 'credentials() and withCredentials: the Groovy-interpolation warning Jenkins prints, and an input step that holds an executor.', tag: 'Security', hue: '#ff6b6b', source: secrets, contexts: null },
  { id: 'mistakes', title: 'Common mistakes (syntax checks)', blurb: 'The errors Jenkins rejects most often, each with the message the validator prints and a hint on how to fix it.', tag: 'Syntax checks', hue: '#9ba1aa', source: mistakes, contexts: null },
];
