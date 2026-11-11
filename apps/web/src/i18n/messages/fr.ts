import type { Messages } from "./en";

/**
 * French, "vous". "fil" for thread, "fournisseur" for provider, "secours" for
 * fallback. Both machine nouns (Mac, poste) are masculine and take "ce".
 */
export const fr: Messages = {
  "common.sentenceSpace": " ",
  "settings.language.title": "Langue",
  "settings.language.description":
    "La langue de SpecWithCode sur cet appareil. Certains écrans sont encore en anglais.",
  "settings.language.system": "Système ({language})",

  "wizard.title": "Configurer SpecWithCode",
  "wizard.stage.connect": "Ordinateurs",
  "wizard.stage.agents": "Agents",
  "wizard.stage.projects": "Projets",
  "wizard.close": "Fermer la configuration",
  "wizard.noun.mac": "Mac",
  "wizard.noun.machine": "poste",
  "wizard.computer": "Ordinateur",
  "wizard.continue": "Continuer",
  "wizard.back": "Retour",
  "wizard.retry": "Réessayer",
  "wizard.closeTerminal": "Fermer",
  "wizard.toast.choiceNotSaved": "Impossible d’enregistrer votre choix",
  "wizard.toast.settingsNotSaved": "Impossible d’enregistrer vos réglages. Réessayez.",
  "wizard.toast.historyNotImported": "Une partie de l’historique n’a pas été importée",
  "wizard.toast.imported": { one: "{count} fil importé", other: "{count} fils importés" },
  "wizard.toast.finishFailed": "Impossible de terminer la configuration",

  "wizard.connection.title": "Connectez vos ordinateurs",
  "wizard.connection.description":
    "Choisissez un ou plusieurs ordinateurs. Nous y configurerons des agents et des projets.",
  "wizard.connection.legend": "Ordinateurs à configurer",
  "wizard.connection.connected": "Connecté",
  "wizard.connection.connecting": "Connexion…",
  "wizard.connection.addComputer": "Ajouter un ordinateur",
  "wizard.connection.telemetry":
    "La télémétrie d’utilisation est désactivée par défaut. SpecWithCode n’envoie aucune donnée d’utilisation sauf si vous l’activez dans l’environnement du serveur.",
  "wizard.connect.loadingSignIn": "Chargement de la connexion…",
  "wizard.connect.signIn": "Se connecter",
  "wizard.connect.loadingComputers": "Chargement des ordinateurs…",
  "wizard.connect.noComputers": "Aucun ordinateur associé pour l’instant.",
  "wizard.connect.runThis":
    "Exécutez ceci sur chaque ordinateur à connecter. Il devient accessible depuis vos autres appareils, sans Tailscale ni redirection de port.",
  "wizard.connect.keepRunning":
    "Laissez SpecWithCode ouvert. Sélectionnez ci-dessus les ordinateurs à configurer.",

  "wizard.pairing.failed": "Échec de l’appairage.",
  "wizard.pairing.label": "Lien d’appairage",
  "wizard.pairing.need": "Besoin d’un lien d’appairage ?",
  "wizard.pairing.pairing": "Appairage...",
  "wizard.pairing.pair": "Appairer",
  "wizard.pairing.runThis": "Exécutez ceci sur l’ordinateur qui contient votre code.",
  "wizard.pairing.startFirst":
    "Lancez d’abord SpecWithCode, ou exécutez {serve}. Ajoutez {tailscale} pour utiliser votre tailnet.",

  "wizard.agents.title": "Connectez vos agents",
  "wizard.agents.description":
    "Choisissez un agent pour commencer à coder. Cursor, OpenCode, Grok et d’autres peuvent être ajoutés après la configuration dans Réglages > Fournisseurs.",
  "wizard.agents.noTerminal": "Cette connexion ne peut pas contrôler de terminaux.",
  "wizard.agents.anotherChatGpt": "Connecter un autre compte ChatGPT",
  "wizard.agents.readyToCode": "Prêt à coder.",
  "wizard.agents.ready": "Prêt",
  "wizard.agents.checking": "Vérification...",
  "wizard.agents.disabled": "Désactivé",
  "wizard.agents.signIn": "Se connecter",
  "wizard.agents.install": "Installer",
  "wizard.terminal.runCommand": "Exécutez {command} dans ce terminal.",
  "wizard.terminal.review": "Vérifiez la commande, puis appuyez sur Entrée pour l’exécuter.",
  "wizard.terminal.openFailed": "Impossible d’ouvrir le terminal de configuration.",
  "wizard.terminal.preparing": "Préparation de la commande...",
  "wizard.terminal.label": "Installer {driver}",

  "wizard.import.noPermission":
    "Cette connexion ne peut pas importer de projets ni d’historique de fils.",
  "wizard.import.scanLimit":
    "Limite d’analyse atteinte. Certains projets ou conversations peuvent manquer.",
  "wizard.import.importedThreads": {
    one: "{count} fil importé.",
    other: "{count} fils importés.",
  },
  "wizard.import.skippedThreads": {
    one: "{count} fil n’a pas pu être importé.",
    other: "{count} fils n’ont pas pu être importés.",
  },
  "wizard.import.someHistoryFailed":
    "Une partie de l’historique des fils n’a pas pu être importée.",
  "wizard.import.historyFailed": "Impossible d’importer l’historique des fils.",
  "wizard.import.yourProjects": "Vos projets",
  "wizard.import.lookingInAgents": "Recherche de projets Claude Code et Codex…",
  "wizard.import.skip": "Ne pas importer de projets",
  "wizard.import.title": "Choisissez vos projets",
  "wizard.import.description":
    "Importez des projets et des conversations depuis les ordinateurs sélectionnés.",
  "wizard.import.selectedCount": "{selected} sur {total} sélectionnés",
  "wizard.import.selectAll": "Tout sélectionner",
  "wizard.import.selectNone": "Tout désélectionner",
  "wizard.import.looking": "Recherche de projets…",
  "wizard.import.checkFailed": "Impossible de vérifier les projets. {error}",
  "wizard.import.none": "Aucun projet Claude Code ou Codex existant trouvé.",
  "wizard.import.importing": "Importation…",
  "wizard.import.importButton": {
    one: "Importer {count} projet",
    other: "Importer {count} projets",
  },
  "wizard.import.otherFolders": "Autres dossiers",
  "wizard.import.folderCount": { one: "{count} dossier", other: "{count} dossiers" },
  "wizard.import.now": "maintenant",

  "wizard.role.title": "Comment allez-vous utiliser ce {machine} ?",
  "wizard.role.changeLater": "Vous pourrez changer cela plus tard.",
  "wizard.role.main.title": "Commencer comme machine principale",
  "wizard.role.main.description":
    "Configurez des agents et des projets sur ce {machine}. Vous pourrez y ajouter d’autres machines plus tard.",
  "wizard.role.join.title": "Se connecter à une machine existante",
  "wizard.role.join.description":
    "Ce {machine} travaille pour votre machine principale située ailleurs. Vous associez SpecWithCode Connect ici, puis vous collez une ligne sur la machine principale.",
  "wizard.role.later": "Décider plus tard",
  "wizard.role.laterHint":
    "Explorez ou mettez à jour d’abord. Pour rejoindre plus tard, choisissez « Rejoindre une machine principale » dans Réglages > Connexions.",
  "wizard.join.title": "Connecter ce {machine} à votre machine principale",
  "wizard.join.step1": "Connectez-vous à SpecWithCode Connect et associez ce {machine}.",
  "wizard.join.step2":
    "Collez l’ID d’environnement de votre machine principale (Réglages > Connexions sur celle-ci) et générez la ligne.",
  "wizard.join.step3":
    "Collez la ligne sur la machine principale dans Réglages > Connexions > Ajouter une machine dans l’heure.",
  "wizard.join.makeLine": "Générer la ligne",
  "wizard.join.pasted": "Je l’ai collée",
  "wizard.joined.title": "Ce {machine} est prêt pour votre machine principale",
  "wizard.joined.description":
    "Il sera prêt dès que vous aurez collé la ligne sur votre machine principale dans Réglages > Connexions > Ajouter une machine. Choisissez « Autoriser les workers » sur sa carte pour que les coordinateurs puissent démarrer du travail ici, et laissez l’app ouverte sur ce {machine}.",
  "wizard.joined.newLine": "Générer une nouvelle ligne",
  "wizard.joined.fullSetup": "Configurer plutôt ce {machine} comme machine principale",

  "update.downloadFailed": "Impossible de télécharger la mise à jour",
  "update.startFailed": "Impossible de lancer le téléchargement de la mise à jour",
  "update.unexpected": "Une erreur inattendue s’est produite.",
  "update.downloaded": "Mise à jour téléchargée",
  "update.quitReopen": "Quittez et rouvrez SpecWithCode pour l’installer.",
  "update.productVersion": "SpecWithCode {version}",
  "update.productNewer": "Une version plus récente de SpecWithCode",
  "update.available": "{product} est disponible. Mettez à jour avant de configurer.",
  "update.downloading": "Téléchargement de la mise à jour…",
  "update.downloadingPercent": "Téléchargement de la mise à jour ({percent} %)…",
  "update.lastFailed": "La dernière installation a échoué : {reason}",
  "update.ready": "{product} est prêt à être installé.",
  "update.aria": "Mise à jour de l’app",
  "update.download": "Télécharger la mise à jour",
  "update.checking": "Vérification…",
  "update.retry": "Réessayer la mise à jour",
  "update.restart": "Redémarrer pour mettre à jour",

  "limit.unavailable.missing": "absent de cette machine",
  "limit.unavailable.limited": "à sa limite",
  "limit.unavailable.signedOut": "déconnecté",
  "limit.unavailable.perToken": "facturé au token",
  "limit.unavailable.full": "épuisé",
  "limit.unavailable.fullUntil": "épuisé jusqu’à {time}",
  "limit.unavailable.tooSmall": "fenêtre de contexte trop petite",
  "limit.unavailable.unverified": "aucune lecture d’utilisation récente",
  "limit.unavailable.providerWarning": "avertissement du fournisseur",
  "limit.unavailable.notReady": "non configuré sur cette machine",
  "limit.unavailable.excluded": "exclu du secours automatique",
  "limit.duration.minutes": "{count} min",
  "limit.duration.hours": "{count} h",
  "limit.duration.hoursMinutes": "{hours} h {minutes} min",
  "limit.duration.days": { one: "{count} jour", other: "{count} jours" },
  "limit.sentenceJoin": ". ",
  "limit.reset.unavailable": "Heure de réinitialisation inconnue",
  "limit.reset.in": "Réinitialisation dans {duration} ({clock})",
  "limit.reset.at": "Réinitialisation à {clock}",
  "limit.next.waiting":
    "La réinitialisation est proche, donc ce fil attend et reprend ici au lieu de changer.",
  "limit.next.resumingNow": "Reprise ici maintenant que la limite est réinitialisée.",
  "limit.next.continuesAtReset": "Ce fil reprend tout seul à la réinitialisation.",
  "limit.next.continuingNow": "Reprise maintenant que la limite est réinitialisée.",
  "limit.next.byRule": "Reprise avec {label} selon la règle du projet.",
  "limit.title.credits": "Crédits API épuisés",
  "limit.title.included": "Limite d’utilisation incluse atteinte",
  "limit.title.usage": "Limite d’utilisation atteinte",
  "limit.creditsExhausted":
    "Ce compte API n’a plus de crédits. Rechargez-le ou continuez sur un autre compte.",
  "limit.error.continueOn": "Impossible de continuer sur {label}.",
  "limit.error.resetPassed":
    "L’heure de réinitialisation est passée. Relancez le fil manuellement.",
  "limit.error.recovery": "Impossible de modifier la reprise après limite.",
  "limit.error.project": "Impossible de modifier le réglage du projet.",
  "limit.auto.savedHint":
    "Enregistré pour ce fil. SpecWithCode reprend tout seul le tour interrompu, même après un redémarrage.",
  "limit.auto.whenUsage": "Reprendre automatiquement quand l’utilisation est disponible",
  "limit.auto.whenReset": "Reprendre automatiquement à la réinitialisation de la limite",
  "limit.saving": "Enregistrement...",
  "limit.project.global": "Activé pour tous les projets dans les Réglages.",
  "limit.project.hint": "Reprend aussi les fils de ce projet qui attendent déjà une limite.",
  "limit.project.label":
    "Reprendre automatiquement les fils de ce projet quand les limites se réinitialisent",
  "limit.noReset.withHandoffs":
    "Le fournisseur n’a pas indiqué quand cette limite se réinitialise, donc le fil ne peut pas reprendre tout seul. Passez maintenant à un autre modèle ou une autre machine, ou envoyez un message après la réinitialisation.",
  "limit.noReset":
    "Le fournisseur n’a pas indiqué quand cette limite se réinitialise, donc le fil ne peut pas reprendre tout seul. Envoyez un message après la réinitialisation.",
  "limit.orElsewhere": "Ou passez maintenant à un autre modèle ou une autre machine :",
  "limit.insteadOfWaiting": "Passer à un autre modèle ou une autre machine au lieu d’attendre :",
  "limit.fallback.hint":
    "Basculer ce fil sur {label} ({model}) et reprendre le tour interrompu avec sa conversation",
  "limit.fallback.continueWith": "Continuer avec {label} · {model}",
  "limit.otherModelsAria": "Autres modèles de secours",
  "limit.otherModels": "Autres modèles",
  "limit.chooseModel": "Choisir un modèle",
  "limit.device.hint":
    "Démarrer un fil sur {label} ({model}) avec un résumé écrit de cette conversation. Les modifications non poussées depuis cet appareil ne suivent pas.",
  "limit.device.fresh": "Repartir de zéro sur {label} (résumé seulement)",
  "limit.device.continue": "Continuer sur {label}",
  "limit.checkRequested": "Vérification demandée",
  "limit.checkNow": "Vérifier maintenant",
  "limit.snooze": "Reporter jusqu’à la réinitialisation",
  "limit.check.allowedOn":
    "La dernière vérification autorisait l’utilisation normale ; la reprise automatique est activée.",
  "limit.check.allowedOff":
    "La dernière vérification autorisait l’utilisation normale. Cochez « Reprendre automatiquement » pour continuer.",
  "limit.check.denied": "Ce profil refuse toujours l’utilisation normale.",
  "limit.check.changed": "Le compte ou le profil a changé. La reprise automatique est bloquée.",
  "limit.check.reconfirm":
    "Vérifiez maintenant, puis décochez et recochez « Reprendre automatiquement » pour confirmer le profil actuel.",
  "limit.check.unverified":
    "Impossible de vérifier l’autorisation d’utilisation normale. Le fil reste arrêté.",
  "limit.approaching.title": "Il reste {percent} % d’utilisation à {provider}",
  "limit.approaching.question":
    "Basculer ce fil sur {label} avant que la limite n’arrête un tour ?",
  "limit.approaching.switch": "Basculer sur {label}",
  "limit.approaching.notNow": "Pas maintenant",
  "limit.preswitch.blocked":
    "{model} approchait de sa limite d’utilisation, donc ce fil a changé avant son prochain tour. Il reste sur le secours : {reason}.",
  "limit.preswitch.hasRoom":
    "{model} approchait de sa limite d’utilisation et a de nouveau de la marge. Le fil inactif y revient tout seul.",
  "limit.preswitch.noRoom":
    "{model} approche de sa limite d’utilisation. Le fil inactif y reviendra tout seul dès qu’il aura de la marge.",

  "fallback.chip.ready": "Prêt",
  "fallback.chip.unverified": "Utilisation inconnue",
  "fallback.chip.full": "Utilisation épuisée",
  "fallback.chip.fullUntil": "Épuisé jusqu’à {time}",
  "fallback.chip.limited": "À sa limite",
  "fallback.chip.signedOut": "Déconnecté",
  "fallback.chip.perToken": "Facturé au token",
  "fallback.chip.tooSmall": "Contexte trop petit",
  "fallback.chip.notReady": "Non configuré",
  "fallback.chip.missing": "Absent de cette machine",
  "fallback.chip.excluded": "Exclu",
  "fallback.chip.unknownBilling": "Facturation inconnue",
  "fallback.family": "Famille {family}",
  "fallback.moveUp": "Monter {label}",
  "fallback.moveDown": "Descendre {label}",
  "fallback.remove": "Retirer {label}",
  "fallback.sameModelAria": "Même modèle chez d’autres fournisseurs, après {label}",
  "fallback.sameModelOn": "Même modèle chez {provider}",
  "fallback.orderLabel": "Ordre de secours",
  "fallback.status.ready": "Peut reprendre un fil limité",
  "fallback.status.unverified": "Connecté, aucune lecture d’utilisation récente",
  "fallback.status.current": "Modèle de ce fil",
  "fallback.status.excluded": "Exclu du secours automatique",
  "fallback.status.disabled": "Désactivé",
  "fallback.status.signedOut": "Déconnecté",
  "fallback.status.notReady": "Non configuré sur cette machine",
  "fallback.status.limited": "À sa limite",
  "fallback.status.full": "Épuisé",
  "fallback.status.fullUntil": "Épuisé jusqu’à {time}",
  "fallback.status.perToken":
    "Facturé au token : seulement si vous le nommez ou autorisez les crédits API",
  "fallback.status.neverAutomatic": "Facture un projet Google Cloud : jamais automatique",
  "fallback.status.namedOnly": "Facturation inconnue : seulement si vous le nommez",
  "fallback.access.notRead": "Utilisation du forfait non lue",
  "fallback.access.reported": "Utilisation du forfait signalée",
  "fallback.access.lastRead": "Dernière lecture : {percent} % utilisés",
  "fallback.access.planUsage": "Forfait utilisé à {percent} %",
  "fallback.access.noUsage": "Connecté ; le fournisseur ne signale aucune utilisation",
  "fallback.access.perToken": "Facturé au token",
  "fallback.access.unknown": "Accès inconnu",
  "fallback.inOrder": "N° {index} dans l’ordre",
  "fallback.include": "Inclure",
  "fallback.exclude": "Exclure",
  "fallback.includeAria": "Inclure {model}",
  "fallback.excludeAria": "Exclure {model}",
  "fallback.providerModels": "Modèles {provider}",
  "fallback.hideOlder": "Masquer les anciennes versions",
  "fallback.showOlder": {
    one: "Afficher {count} ancienne version",
    other: "Afficher {count} anciennes versions",
  },
  "fallback.noProviders": "Aucun fournisseur sur cette machine pour l’instant.",
  "fallback.footnote":
    "Un modèle exclu reste hors de toute bascule automatique, chez tous les fournisseurs ; vous pouvez toujours le choisir vous-même. Les nouveaux modèles sont autorisés tant que vous ne les excluez pas. L’accès affiché ici est seulement ce que SpecWithCode peut voir : des minutes GitHub Actions, un abonnement X ou des crédits startup ne donnent pas accès aux modèles, sauf si l’un de ces fournisseurs est connecté avec eux.",
  "fallback.summary.models": { one: "{count} modèle", other: "{count} modèles" },
  "fallback.summary.ready": "{count} prêts maintenant",
  "fallback.summary.excluded": "{count} exclus",

  "limitSettings.mixed": "Mixte",
  "limitSettings.cancel": "Annuler",
  "limitSettings.action.ask": "Proposer le secours",
  "limitSettings.action.wait": "Attendre la réinitialisation",
  "limitSettings.action.switch": "Basculer automatiquement",
  "limitSettings.switchAtOption": "À {percent} % restants",
  "limitSettings.waitOption.never": "Ne jamais attendre",
  "limitSettings.waitOption.hour": "Moins d’1 heure",
  "limitSettings.waitOption.twoHours": "Moins de 2 heures",
  "limitSettings.waitOption.minutes": "Moins de {minutes} min",
  "limitSettings.action.title": "Quand un fournisseur est épuisé",
  "limitSettings.action.descriptionProject":
    "Ce que font les fils de ce projet quand leur fournisseur atteint une limite d’utilisation. Basculer transmet le fil avec son contexte, dans le même worktree.",
  "limitSettings.action.description":
    "Ce que font les fils quand leur fournisseur atteint une limite d’utilisation. Les projets peuvent le remplacer.",
  "limitSettings.order.title": "Ordre de secours",
  "limitSettings.order.description":
    "Les modèles sur lesquels un fil limité continue, le meilleur en premier. Le premier connecté et disposant de marge reprend le fil ; un fil qui y est déjà le saute, ce qui permet aux fils Codex de basculer sur Claude depuis la même liste.",
  "limitSettings.order.descriptionTiers":
    "Laissez-la vide pour suivre plutôt vos niveaux de modèles ; une liste ici les remplace pour les limites.",
  "limitSettings.order.descriptionWaits": "Quand aucun n’a de marge, le fil attend.",
  "limitSettings.order.descriptionAny":
    "Après ceux-ci, SpecWithCode essaie tout autre fournisseur prêt.",
  "limitSettings.order.statusTiers": "Utilise vos niveaux de modèles",
  "limitSettings.order.statusAny": "Tout fournisseur prêt",
  "limitSettings.order.addModel": "Ajouter un modèle",
  "limitSettings.order.addAria": "Ajouter un modèle de secours",
  "limitSettings.order.noProviders": "Aucun fournisseur disponible",
  "limitSettings.listOnly.title": "Uniquement ces modèles",
  "limitSettings.listOnly.descriptionTiers":
    "Ne jamais continuer un fil limité sur un modèle hors de vos niveaux de modèles. Quand aucun n’a de marge, le fil attend sa réinitialisation.",
  "limitSettings.listOnly.descriptionOrder":
    "Ne jamais continuer un fil limité sur un modèle hors de l’ordre de secours. Quand aucun n’a de marge, le fil attend sa réinitialisation.",
  "limitSettings.options.title": "Où un fil limité peut continuer",
  "limitSettings.options.description":
    "Les modèles de cette machine vers lesquels un fil limité peut passer, regroupés par famille et par fournisseur, les anciennes versions repliées. Excluez un modèle pour le tenir à l’écart du secours automatique ; pour fixer le minimum d’une famille, excluez les modèles en dessous.",
  "limitSettings.options.none": "Rien d’exclu",
  "limitSettings.options.count": "{count} exclus",
  "limitSettings.switchAt.title": "Basculer avant la limite",
  "limitSettings.switchAt.description":
    "Avec « Basculer automatiquement », le tour suivant démarre sur le secours dès que la fenêtre d’utilisation la plus basse du fournisseur n’a plus que ce reste. Avec « Proposer le secours », le fil propose la bascule à ce moment-là. Jamais en plein tour, et seulement vers un fournisseur qui a plus de marge.",
  "limitSettings.switchAt.off": "Seulement à l’arrêt",
  "limitSettings.waitUnder.title": "Attendre quand la réinitialisation est proche",
  "limitSettings.waitUnder.description":
    "Quand l’utilisation qui a atteint la limite ou le seuil se réinitialise dans ce délai, rien ne bascule, rien n’est utilisé ni dépensé : le fil attend et reprend sur le même fournisseur à la réinitialisation. Une fenêtre hebdomadaire elle aussi épuisée empêche cette attente.",
  "limitSettings.subscription.title": "Continuer automatiquement sur un nouvel abonnement",
  "limitSettings.subscription.description":
    "Quand un fil attend une limite d’utilisation et que sa CLI est connectée à un autre abonnement qui a de la marge, le fil continue là sans demander, que la reprise automatique soit activée ou non. Un fil dont le dernier rapport était bloqué par une limite d’utilisation est aussi informé du changement. Un fil que vous avez arrêté reste arrêté. Si désactivé : le fil affiche le changement et attend votre confirmation. Le fournisseur et le modèle restent les mêmes.",
  "limitSettings.redeem.title": "Utiliser d’abord une réinitialisation en réserve",
  "limitSettings.redeem.description":
    "Quand un tour s’arrête sur la limite et qu’une nouvelle lecture confirme que le compte l’a atteinte, utiliser une des réinitialisations en réserve du compte (Claude et Codex en accordent) et continuer sur le même fournisseur avant tout secours. Au plus une par fenêtre de limite, jamais pendant une simulation de limites.",
  "limitSettings.spend.title": "Dépenser d’abord les crédits Codex",
  "limitSettings.spend.description":
    "Quand un tour Codex s’arrête sur la limite du forfait et que le compte dispose de crédits payants, continuer ce tour sur les crédits avant tout secours. SpecWithCode n’achète jamais de crédits et ne modifie jamais la recharge automatique.",
  "limitSettings.api.title": "Utiliser d’abord les crédits API",
  "limitSettings.api.description":
    "Quand un tour d’abonnement Claude s’arrête sur la limite et qu’une nouvelle lecture le confirme, continuer ce tour sur le même modèle avec une instance Claude facturée en crédits API Anthropic (sa propre clé API ou une connexion Claude Console), avant tout secours. Avec plusieurs comptes API, un tour refusé par l’un faute de crédits passe au suivant. Le fil revient à l’abonnement à la réinitialisation de la limite, ou dès que cette option est désactivée. Jamais pendant une simulation de limites. Sans cette option, la bannière de limite propose quand même chaque compte sous forme de bouton.",
  "limitSettings.api.statusNext":
    "Continue sur {name}, puis sur le suivant des {count} comptes API",
  "limitSettings.api.statusOne": "Continue sur {name} s’il propose le modèle du fil",
  "limitSettings.api.statusNotReady": "{name} n’est pas prêt, donc rien ne bouge",
  "limitSettings.api.statusNeeds": "Nécessite un compte API Claude : ajoutez-en un avec sa clé",
  "limitSettings.api.addKey": "Ajouter une clé API",
  "limitSettings.api.addAnother": "En ajouter une autre",
  "limitSettings.redeem.confirmTitle":
    "Utiliser automatiquement les réinitialisations en réserve ?",
  "limitSettings.redeem.confirmProject":
    "Les tours de ce projet qui s’arrêtent sur une limite d’utilisation confirmée utiliseront sans demander une des réinitialisations en réserve du compte, au plus une par fenêtre de limite. Une réinitialisation utilisée est perdue.",
  "limitSettings.redeem.confirmGlobal":
    "Les tours qui s’arrêtent sur une limite d’utilisation confirmée utiliseront sans demander une des réinitialisations en réserve du compte, au plus une par fenêtre de limite, dans chaque projet qui ne remplace pas ce réglage. Une réinitialisation utilisée est perdue.",
  "limitSettings.redeem.confirm": "Utiliser les réinitialisations",
  "limitSettings.spend.confirmTitle": "Dépenser automatiquement les crédits Codex payants ?",
  "limitSettings.spend.confirmProject":
    "Les tours de ce projet qui s’arrêtent sur la limite du forfait Codex continueront sans demander sur les crédits payants du compte. Les crédits coûtent de l’argent et ne sont pas remboursés.",
  "limitSettings.spend.confirmGlobal":
    "Les tours qui s’arrêtent sur la limite du forfait Codex continueront sans demander sur les crédits payants du compte, dans chaque projet qui ne remplace pas ce réglage. Les crédits coûtent de l’argent et ne sont pas remboursés.",
  "limitSettings.spend.confirm": "Dépenser les crédits",
  "limitSettings.api.confirmTitle": "Utiliser automatiquement les crédits API Claude ?",
  "limitSettings.api.confirmProject":
    "Les tours de ce projet qui s’arrêtent sur une limite d’abonnement Claude confirmée continueront sans demander sur votre instance Claude avec clé API, en passant au compte API suivant si l’un n’a plus de crédits, et le fil y reste jusqu’à la réinitialisation de la limite. Chaque tour exécuté là, et tout fil démarré depuis là, est facturé à l’organisation API de la clé aux tarifs API. SpecWithCode ne peut ni lire ni plafonner ce solde ; définissez une limite de dépenses dans la Claude Console.",
  "limitSettings.api.confirmGlobal":
    "Les tours qui s’arrêtent sur une limite d’abonnement Claude confirmée continueront sans demander sur votre instance Claude avec clé API, en passant au compte API suivant si l’un n’a plus de crédits, dans chaque projet qui ne remplace pas ce réglage, et le fil y reste jusqu’à la réinitialisation de la limite. Chaque tour exécuté là, et tout fil démarré depuis là, est facturé à l’organisation API de la clé aux tarifs API. SpecWithCode ne peut ni lire ni plafonner ce solde ; définissez une limite de dépenses dans la Claude Console.",
  "limitSettings.api.confirm": "Utiliser les crédits API",
  "providerModels.count": { one: "{count} modèle", other: "{count} modèles" },
  "providerModels.favorites": { one: "{count} favori", other: "{count} favoris" },
  "providerModels.hidden": { one: "{count} masqué", other: "{count} masqués" },
  "sidebar.needYou": { one: "vous attend", other: "vous attendent" },
  "sidebar.chatCount": { one: "{count} chat", other: "{count} chats" },
  "sidebar.openChatCount": { one: "{count} chat ouvert", other: "{count} chats ouverts" },
};
