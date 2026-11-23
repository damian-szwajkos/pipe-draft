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

export const EXAMPLES = [
  { id: 'multibranch', title: 'Build, test, deploy (multibranch)', source: multibranch, contexts: null },
  { id: 'monorepo', title: 'Monorepo: changeset and changelog', source: monorepo, contexts: monorepoContexts },
  { id: 'matrix', title: 'Matrix build with excludes', source: matrix, contexts: matrixContexts },
  { id: 'params', title: 'Parameters, retry, triggeredBy', source: params, contexts: paramsContexts },
  { id: 'scripted', title: 'Scripted pipeline (node / if / loops)', source: scripted, contexts: scriptedContexts },
  { id: 'secrets', title: 'Credentials and input', source: secrets, contexts: null },
  { id: 'mistakes', title: 'Common mistakes (syntax checks)', source: mistakes, contexts: null },
];
